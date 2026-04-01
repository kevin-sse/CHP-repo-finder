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

const checkpointFile = path.join(__dirname, 'checkpoints', 'progress.json');
const runTimestamp = new Date().toISOString().replace(/:/g, '-');
const outputDir = path.join(__dirname, 'results', runTimestamp);

fs.mkdirSync(path.join(__dirname, 'checkpoints'), { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Checkpoint: single file tracking current progress ---

function loadCheckpoint() {
  if (fs.existsSync(checkpointFile)) {
    return JSON.parse(fs.readFileSync(checkpointFile, 'utf-8'));
  }
  return { completedRanges: [], outputDir: null };
}

function saveCheckpoint(state) {
  fs.writeFileSync(checkpointFile, JSON.stringify(state, null, 2));
}

function rangeKey(lang, range) {
  return `${lang}_${range.stars}`;
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

async function buildRanges(language, starMin, starMax) {
  // pushed:>YYYY-MM-DD ensures only repos updated within the last month
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const pushedSince = oneMonthAgo.toISOString().split('T')[0];

  const baseQuery = `language:${language} is:public archived:false pushed:>${pushedSince}`;
  const ranges = [];

  async function splitByStars(lo, hi) {
    const query = `stars:${lo}..${hi} ${baseQuery}`;
    const count = await getSearchCount(query);
    console.log(`  stars:${lo}..${hi} → ${count} repos`);
    await sleep(600);

    if (count <= 1000) {
      ranges.push({ stars: `${lo}..${hi}`, count, query });
      return;
    }

    if (lo === hi) {
      // Can't split further, fetch what we can
      console.log(`    ⚠ stars:${lo} still has ${count} repos, fetching max 1,000`);
      ranges.push({ stars: `${lo}..${hi}`, count, query });
      return;
    }

    const mid = Math.floor((lo + hi) / 2);
    await splitByStars(lo, mid);
    await splitByStars(mid + 1, hi);
  }

  await splitByStars(starMin, starMax);
  return ranges;
}

// --- Check contributors & recent issues ---

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

// --- Process one chunk: fetch → filter → save result ---

async function processChunk(lang, range, seen, targetDir) {
  console.log(`\n  Fetching stars:${range.stars} (${range.count} repos)...`);
  const repos = await fetchAllPages(range.query);

  // Dedup
  const uniqueRepos = repos.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  console.log(`  ${uniqueRepos.length} unique repos. Checking contributors & issues...\n`);

  const results = [];

  for (let i = 0; i < uniqueRepos.length; i++) {
    const repo = uniqueRepos[i];
    process.stdout.write(`    [${i + 1}/${uniqueRepos.length}] ${repo.full_name} ... `);

    const contributorsCount = await getContributorsCount(repo.full_name);

    if (contributorsCount > 2) {
      const hasRecentOpenIssues = await getRecentOpenIssues(repo.full_name);

      if (hasRecentOpenIssues) {
        results.push({
          repo: repo.full_name,
          url: repo.html_url,
          about: repo.description || '(no description)',
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          language: repo.language,
          topics: repo.topics || [],
          contributors: contributorsCount,
          hasRecentOpenIssues: true,
          createdAt: repo.created_at,
          lastUpdated: repo.updated_at,
          license: repo.license ? repo.license.spdx_id : null,
        });
        console.log(`✓ MATCH (${contributorsCount} contributors)`);
      } else {
        console.log(`✗ no recent issues`);
      }
    } else {
      console.log(`✗ ${contributorsCount} contributors`);
    }

    if (i % 5 === 4) await sleep(500);
  }

  // Save completed result file
  const output = {
    searchInfo: {
      language: lang,
      starRange: range.stars,
      query: range.query,
      totalInRange: range.count,
      fetchedCount: uniqueRepos.length,
      matchedCount: results.length,
      completedAt: new Date().toISOString(),
      filters: {
        minContributors: 3,
        requireRecentOpenIssues: true,
        recentIssueWindow: '1 month',
      },
    },
    results: results,
  };

  const filename = `${lang}_stars-${range.stars.replace('..', '-')}.json`;
  fs.writeFileSync(path.join(targetDir, filename), JSON.stringify(output, null, 2));
  console.log(`  💾 Saved ${results.length} matched repos → results/${path.basename(targetDir)}/${filename}`);

  return results.length;
}

// --- Main ---

async function main() {
  const startTime = new Date();
  const checkpoint = loadCheckpoint();

  // Resume previous run's output dir, or use new one
  const activeOutputDir = checkpoint.outputDir || outputDir;
  fs.mkdirSync(activeOutputDir, { recursive: true });

  // Update outputDir reference for processChunk
  // (we reuse the module-level var by reassigning isn't ideal, so just use activeOutputDir)

  console.log('=== GitHub Repo Finder ===');
  console.log(`Languages: ${languages.join(', ')}`);
  console.log(`Stars: ${minStars}..${maxStars}`);
  console.log(`Output: ${activeOutputDir}`);
  console.log(`Started: ${startTime.toISOString()}`);

  if (checkpoint.completedRanges.length > 0) {
    console.log(`Resuming — ${checkpoint.completedRanges.length} range(s) already done`);
  }
  console.log();

  const completedSet = new Set(checkpoint.completedRanges);
  const seen = new Set(); // global dedup
  let totalMatched = 0;

  for (const lang of languages) {
    console.log(`[${lang}] Splitting star ranges...`);
    const ranges = await buildRanges(lang, minStars, maxStars);
    console.log(`[${lang}] ${ranges.length} range(s)`);

    for (const range of ranges) {
      if (range.count === 0) continue;

      const key = rangeKey(lang, range);
      if (completedSet.has(key)) {
        console.log(`  [${lang}] stars:${range.stars} — SKIPPED (already done)`);
        continue;
      }

      const matched = await processChunk(lang, range, seen, activeOutputDir);
      totalMatched += matched;

      // Update checkpoint
      checkpoint.completedRanges.push(key);
      checkpoint.outputDir = activeOutputDir;
      saveCheckpoint(checkpoint);
    }
  }

  // Clear checkpoint on successful completion
  if (fs.existsSync(checkpointFile)) {
    fs.unlinkSync(checkpointFile);
  }

  const endTime = new Date();
  console.log(`\n=== Done ===`);
  console.log(`Total matched: ${totalMatched}`);
  console.log(`Duration: ${Math.round((endTime - startTime) / 1000)}s`);
  console.log(`Results: ${activeOutputDir}`);
}

main().catch((error) => {
  console.error('Error:', error);
});
