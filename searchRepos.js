require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const token = process.env.GITHUB_TOKEN;
const languages = (process.env.LANGUAGES || 'JavaScript').split(',').map(l => l.trim());
const minStars = parseInt(process.env.MIN_STARS || '10');
const maxStars = parseInt(process.env.MAX_STARS || '200');

if (!token || token === 'your-github-token-here') {
  console.error('Please set your GITHUB_TOKEN in the .env file');
  process.exit(1);
}

const checkpointDir = path.join(__dirname, 'checkpoints');
const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(checkpointDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Checkpoint helpers ---

function getCheckpointPath(lang, lo, hi) {
  return path.join(checkpointDir, `${lang}_stars-${lo}-${hi}.json`);
}

function checkpointExists(filepath) {
  return fs.existsSync(filepath);
}

function readCheckpoint(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

function writeCheckpoint(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// --- API helpers ---

async function apiFetch(url) {
  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    }
  });

  const remaining = response.headers.get('x-ratelimit-remaining');
  const resetTime = response.headers.get('x-ratelimit-reset');

  if (response.status === 403 && remaining === '0') {
    const waitSeconds = Math.max(0, parseInt(resetTime) - Math.floor(Date.now() / 1000)) + 5;
    console.log(`  ⏳ Rate limited. Waiting ${waitSeconds}s for reset...`);
    await sleep(waitSeconds * 1000);
    return apiFetch(url);
  }

  if (response.status === 422) {
    console.log(`  ⚠ GitHub returned 422, skipping...`);
    return null;
  }

  return response.json();
}

async function getSearchCount(query) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=1`;
  const data = await apiFetch(url);
  return data?.total_count || 0;
}

async function fetchAllPages(query) {
  const allItems = [];
  const perPage = 100;

  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&sort=stars&order=asc`;
    const data = await apiFetch(url);

    if (!data || !data.items) {
      console.error('    API error:', data?.message || 'unknown');
      break;
    }

    allItems.push(...data.items);
    console.log(`    Page ${page}: +${data.items.length} repos (total available: ${data.total_count})`);

    if (data.items.length < perPage) break;
    await sleep(1200);
  }

  return allItems;
}

async function buildStarRanges(language, starMin, starMax) {
  const baseQuery = `language:${language} is:public archived:false`;
  const ranges = [];

  async function splitRange(lo, hi) {
    const query = `stars:${lo}..${hi} ${baseQuery}`;
    const count = await getSearchCount(query);
    console.log(`  stars:${lo}..${hi} → ${count} repos`);
    await sleep(600);

    if (count <= 1000) {
      ranges.push({ lo, hi, count, query });
      return;
    }

    if (lo === hi) {
      console.log(`    ⚠ stars:${lo} has ${count} repos, can only fetch 1,000`);
      ranges.push({ lo, hi, count, query });
      return;
    }

    const mid = Math.floor((lo + hi) / 2);
    await splitRange(lo, mid);
    await splitRange(mid + 1, hi);
  }

  await splitRange(starMin, starMax);
  return ranges;
}

// ======================================================================
// STEP 1: FETCH — download all repos, save raw data to checkpoint files
// ======================================================================

async function stepFetch() {
  console.log('=== STEP 1: FETCH ===\n');

  for (const lang of languages) {
    console.log(`[${lang}] Checking counts and splitting ranges...`);
    const ranges = await buildStarRanges(lang, minStars, maxStars);
    console.log(`[${lang}] ${ranges.length} range(s): ${ranges.map(r => `${r.lo}..${r.hi}(${r.count})`).join(', ')}\n`);

    for (const range of ranges) {
      if (range.count === 0) continue;

      const cpPath = getCheckpointPath(lang, range.lo, range.hi);

      // Resume: skip if already fetched
      if (checkpointExists(cpPath)) {
        const existing = readCheckpoint(cpPath);
        console.log(`  [${lang}] stars:${range.lo}..${range.hi} — SKIPPED (already fetched ${existing.repos.length} repos)`);
        continue;
      }

      console.log(`  [${lang}] Fetching stars:${range.lo}..${range.hi} (${range.count} repos)...`);
      const repos = await fetchAllPages(range.query);

      // Save raw repo data to checkpoint
      const checkpoint = {
        language: lang,
        starRange: `${range.lo}..${range.hi}`,
        query: range.query,
        totalInRange: range.count,
        fetchedAt: new Date().toISOString(),
        repos: repos.map(r => ({
          id: r.id,
          repo: r.full_name,
          url: r.html_url,
          about: r.description || '(no description)',
          stars: r.stargazers_count,
          forks: r.forks_count,
          language: r.language,
          topics: r.topics || [],
          createdAt: r.created_at,
          lastUpdated: r.updated_at,
          license: r.license ? r.license.spdx_id : null,
        })),
      };

      writeCheckpoint(cpPath, checkpoint);
      console.log(`  💾 Checkpoint saved: ${path.basename(cpPath)} (${repos.length} repos)\n`);
    }
  }

  console.log('FETCH complete.\n');
}

// ======================================================================
// STEP 2: FILTER — read checkpoints, check contributors & issues, save
// ======================================================================

async function getContributorsCount(repoFullName) {
  const url = `https://api.github.com/repos/${repoFullName}/contributors?per_page=100`;
  const data = await apiFetch(url);
  return Array.isArray(data) ? data.length : 0;
}

async function getRecentOpenIssues(repoFullName) {
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  const url = `https://api.github.com/repos/${repoFullName}/issues?state=open&since=${oneMonthAgo.toISOString()}&per_page=5`;
  const data = await apiFetch(url);
  return Array.isArray(data) && data.length > 0;
}

async function stepFilter() {
  console.log('=== STEP 2: FILTER ===\n');

  // Find all fetch checkpoint files
  const cpFiles = fs.readdirSync(checkpointDir)
    .filter(f => f.endsWith('.json') && !f.includes('_filtered'));

  const seen = new Set(); // global dedup

  for (const cpFile of cpFiles) {
    const cpPath = path.join(checkpointDir, cpFile);
    const filteredPath = cpPath.replace('.json', '_filtered.json');

    const checkpoint = readCheckpoint(cpPath);

    // Resume: if already fully filtered, skip
    if (checkpointExists(filteredPath)) {
      const existing = readCheckpoint(filteredPath);
      if (existing.completed) {
        console.log(`[${checkpoint.language}] ${checkpoint.starRange} — SKIPPED (already filtered, ${existing.results.length} matched)`);
        existing.results.forEach(r => seen.add(r.repo));
        continue;
      }
    }

    // Load partial progress if exists
    let filtered = [];
    let startIndex = 0;
    if (checkpointExists(filteredPath)) {
      const partial = readCheckpoint(filteredPath);
      filtered = partial.results || [];
      startIndex = partial.processedCount || 0;
      filtered.forEach(r => seen.add(r.repo));
      console.log(`[${checkpoint.language}] ${checkpoint.starRange} — RESUMING from repo ${startIndex + 1}/${checkpoint.repos.length}`);
    } else {
      console.log(`[${checkpoint.language}] ${checkpoint.starRange} — Filtering ${checkpoint.repos.length} repos...`);
    }

    const repos = checkpoint.repos;

    for (let i = startIndex; i < repos.length; i++) {
      const repo = repos[i];

      // Dedup across chunks
      if (seen.has(repo.repo)) {
        process.stdout.write(`    [${i + 1}/${repos.length}] ${repo.repo} ... ✗ duplicate\n`);
        continue;
      }
      seen.add(repo.repo);

      process.stdout.write(`    [${i + 1}/${repos.length}] ${repo.repo} ... `);

      const contributorsCount = await getContributorsCount(repo.repo);

      if (contributorsCount > 2) {
        const hasRecentOpenIssues = await getRecentOpenIssues(repo.repo);

        if (hasRecentOpenIssues) {
          filtered.push({
            ...repo,
            contributors: contributorsCount,
            hasRecentOpenIssues: true,
          });
          console.log(`✓ MATCH (${contributorsCount} contributors)`);
        } else {
          console.log(`✗ no recent issues`);
        }
      } else {
        console.log(`✗ ${contributorsCount} contributors`);
      }

      // Save progress every 10 repos
      if (i % 10 === 9) {
        writeCheckpoint(filteredPath, {
          language: checkpoint.language,
          starRange: checkpoint.starRange,
          processedCount: i + 1,
          totalCount: repos.length,
          completed: false,
          results: filtered,
        });
      }

      if (i % 5 === 4) await sleep(500);
    }

    // Mark as completed
    writeCheckpoint(filteredPath, {
      language: checkpoint.language,
      starRange: checkpoint.starRange,
      processedCount: repos.length,
      totalCount: repos.length,
      completed: true,
      results: filtered,
    });

    console.log(`  💾 Filtered: ${filtered.length} matched out of ${repos.length}\n`);
  }

  console.log('FILTER complete.\n');
}

// ======================================================================
// STEP 3: EXPORT — combine all filtered results into final output
// ======================================================================

function stepExport() {
  console.log('=== STEP 3: EXPORT ===\n');

  const filteredFiles = fs.readdirSync(checkpointDir)
    .filter(f => f.includes('_filtered.json'));

  const allResults = [];
  const seen = new Set();

  for (const f of filteredFiles) {
    const data = readCheckpoint(path.join(checkpointDir, f));
    for (const repo of (data.results || [])) {
      if (!seen.has(repo.repo)) {
        seen.add(repo.repo);
        allResults.push(repo);
      }
    }
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const output = {
    searchInfo: {
      languages: languages,
      starRange: `${minStars}..${maxStars}`,
      exportedAt: new Date().toISOString(),
      totalMatched: allResults.length,
      filters: {
        minContributors: 3,
        requireRecentOpenIssues: true,
        recentIssueWindow: '1 month',
      },
    },
    results: allResults,
  };

  const filename = `${timestamp}.json`;
  const filepath = path.join(resultsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(output, null, 2));

  console.log(`Exported ${allResults.length} repos → results/${filename}`);
}

// ======================================================================
// MAIN
// ======================================================================

async function main() {
  const startTime = new Date();
  console.log('=== GitHub Repo Finder ===');
  console.log(`Languages: ${languages.join(', ')}`);
  console.log(`Stars: ${minStars}..${maxStars}`);
  console.log(`Checkpoints: ${checkpointDir}`);
  console.log(`Started: ${startTime.toISOString()}\n`);

  await stepFetch();
  await stepFilter();
  stepExport();

  const endTime = new Date();
  console.log(`\nTotal duration: ${Math.round((endTime - startTime) / 1000)}s`);
}

main().catch((error) => {
  console.error('Error:', error);
});
