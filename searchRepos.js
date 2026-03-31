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

// Create output directory with timestamp
const runTimestamp = new Date().toISOString().replace(/:/g, '-');
const outputDir = path.join(__dirname, 'results', runTimestamp);
fs.mkdirSync(outputDir, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// Save one file per fetch chunk (language + star range)
function saveChunkFile(lang, range, repos, filtered) {
  const filename = `${lang}_stars-${range.lo}-${range.hi}.json`;
  const filepath = path.join(outputDir, filename);

  const output = {
    searchInfo: {
      language: lang,
      starRange: `${range.lo}..${range.hi}`,
      query: range.query,
      totalInRange: range.count,
      fetchedCount: repos.length,
      matchedCount: filtered.length,
      fetchedAt: new Date().toISOString(),
      filters: {
        minContributors: 3,
        requireRecentOpenIssues: true,
        recentIssueWindow: '1 month',
      },
    },
    results: filtered,
  };

  fs.writeFileSync(filepath, JSON.stringify(output, null, 2));
  console.log(`  💾 Saved ${filtered.length} results → ${filename}`);
  return filepath;
}

async function filterRepos(repos) {
  const results = [];

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    process.stdout.write(`    [${i + 1}/${repos.length}] ${repo.full_name} ... `);

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

  return results;
}

async function main() {
  const startTime = new Date();
  console.log('=== GitHub Repo Finder ===');
  console.log(`Languages: ${languages.join(', ')}`);
  console.log(`Stars: ${minStars}..${maxStars}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Started: ${startTime.toISOString()}\n`);

  const allSavedFiles = [];
  let totalFetched = 0;
  let totalMatched = 0;
  const seen = new Set(); // global dedup across all chunks

  for (const lang of languages) {
    console.log(`\n[${lang}] Checking counts and splitting ranges...`);
    const ranges = await buildStarRanges(lang, minStars, maxStars);

    console.log(`[${lang}] ${ranges.length} range(s): ${ranges.map(r => `${r.lo}..${r.hi}(${r.count})`).join(', ')}`);

    for (const range of ranges) {
      if (range.count === 0) continue;

      console.log(`\n  [${lang}] Fetching stars:${range.lo}..${range.hi} (${range.count} repos)...`);
      const repos = await fetchAllPages(range.query);

      // Deduplicate
      const uniqueRepos = repos.filter(repo => {
        if (seen.has(repo.id)) return false;
        seen.add(repo.id);
        return true;
      });

      console.log(`  [${lang}] ${uniqueRepos.length} unique repos, filtering...\n`);
      totalFetched += uniqueRepos.length;

      // Filter and save immediately
      const filtered = await filterRepos(uniqueRepos);
      totalMatched += filtered.length;

      const savedFile = saveChunkFile(lang, range, uniqueRepos, filtered);
      allSavedFiles.push(savedFile);
    }
  }

  // Save a summary file
  const endTime = new Date();
  const summary = {
    searchInfo: {
      languages: languages,
      starRange: `${minStars}..${maxStars}`,
      executedAt: startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationSeconds: Math.round((endTime - startTime) / 1000),
      totalReposFound: totalFetched,
      totalReposMatched: totalMatched,
      chunkFiles: allSavedFiles.map(f => path.basename(f)),
      filters: {
        minContributors: 3,
        requireRecentOpenIssues: true,
        recentIssueWindow: '1 month',
      },
    },
  };

  const summaryPath = path.join(outputDir, '_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`\n=== Done ===`);
  console.log(`Total repos searched: ${totalFetched}`);
  console.log(`Total matched: ${totalMatched}`);
  console.log(`Duration: ${Math.round((endTime - startTime) / 1000)}s`);
  console.log(`Files saved to: ${outputDir}`);
}

main().catch((error) => {
  console.error('Error running the script:', error);
});
