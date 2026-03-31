require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const token = process.env.GITHUB_TOKEN;
const searchQuery = process.env.SEARCH_QUERY || 'stars:10..200 language:JavaScript is:public archived:false';

if (!token || token === 'your-github-token-here') {
  console.error('Please set your GITHUB_TOKEN in the .env file');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Strategy to bypass GitHub's 1,000 result limit:
//
// GitHub Search API returns max 1,000 results per query.
// We split the star range into smaller sub-ranges so each sub-query returns
// fewer than 1,000 results. For example, "stars:10..200" becomes:
//   stars:10..50, stars:51..100, stars:101..200
// Each sub-range is paginated (100 per page, up to 10 pages = 1,000).
// If a sub-range still hits 1,000, we split it further automatically.
// ---------------------------------------------------------------------------

function parseStarRange(query) {
  const match = query.match(/stars:(\d+)\.\.(\d+)/);
  if (!match) return null;
  return { min: parseInt(match[1]), max: parseInt(match[2]) };
}

function replaceStarRange(query, min, max) {
  return query.replace(/stars:\d+\.\.\d+/, `stars:${min}..${max}`);
}

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

  // Handle rate limiting
  const remaining = response.headers.get('x-ratelimit-remaining');
  const resetTime = response.headers.get('x-ratelimit-reset');

  if (response.status === 403 && remaining === '0') {
    const waitSeconds = Math.max(0, parseInt(resetTime) - Math.floor(Date.now() / 1000)) + 5;
    console.log(`  ⏳ Rate limited. Waiting ${waitSeconds}s for reset...`);
    await sleep(waitSeconds * 1000);
    return apiFetch(url); // retry
  }

  if (response.status === 422) {
    console.log(`  ⚠ GitHub returned 422 (validation error), skipping...`);
    return null;
  }

  return response.json();
}

// Fetch all pages for a single search query (up to 1,000 results)
async function fetchAllPages(query) {
  const allItems = [];
  const perPage = 100;
  const maxPages = 10; // 10 * 100 = 1,000

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&sort=stars&order=asc`;
    const data = await apiFetch(url);

    if (!data || !data.items) {
      console.error('  GitHub API error:', data?.message || 'unknown error');
      break;
    }

    allItems.push(...data.items);

    const totalCount = data.total_count;
    console.log(`  Page ${page}: got ${data.items.length} repos (total available: ${totalCount})`);

    if (data.items.length < perPage) break; // no more pages

    // Small delay to avoid secondary rate limits
    await sleep(1000);
  }

  return allItems;
}

// Recursively split star ranges to get past the 1,000 limit
async function searchWithSplitting(query) {
  const starRange = parseStarRange(query);

  if (!starRange) {
    // No star range found, just do a normal search
    console.log(`\nSearching: ${query}`);
    return fetchAllPages(query);
  }

  // First, check how many total results this range has
  const checkUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=1`;
  const checkData = await apiFetch(checkUrl);

  if (!checkData || !checkData.total_count) {
    return [];
  }

  const totalCount = checkData.total_count;
  console.log(`\nRange stars:${starRange.min}..${starRange.max} → ${totalCount} repos`);

  if (totalCount <= 1000) {
    // Safe to fetch all pages directly
    return fetchAllPages(query);
  }

  // Need to split into smaller ranges
  if (starRange.min === starRange.max) {
    // Can't split further, just get what we can
    console.log(`  Cannot split further (single star value), fetching max 1,000`);
    return fetchAllPages(query);
  }

  const mid = Math.floor((starRange.min + starRange.max) / 2);
  console.log(`  Splitting into stars:${starRange.min}..${mid} and stars:${mid + 1}..${starRange.max}`);

  const leftQuery = replaceStarRange(query, starRange.min, mid);
  const rightQuery = replaceStarRange(query, mid + 1, starRange.max);

  const leftResults = await searchWithSplitting(leftQuery);
  const rightResults = await searchWithSplitting(rightQuery);

  return [...leftResults, ...rightResults];
}

async function getContributorsCount(repoFullName) {
  const url = `https://api.github.com/repos/${repoFullName}/contributors?per_page=100`;
  const data = await apiFetch(url);
  return Array.isArray(data) ? data.length : 0;
}

async function getRecentOpenIssues(repoFullName) {
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const formattedDate = oneMonthAgo.toISOString();

  const url = `https://api.github.com/repos/${repoFullName}/issues?state=open&since=${formattedDate}&per_page=5`;
  const data = await apiFetch(url);
  return Array.isArray(data) && data.length > 0;
}

async function main() {
  const startTime = new Date();
  console.log('=== GitHub Repo Finder ===');
  console.log(`Search query: ${searchQuery}`);
  console.log(`Started at: ${startTime.toISOString()}\n`);

  // Phase 1: Search repos with auto-splitting
  const allRepos = await searchWithSplitting(searchQuery);

  // Deduplicate by repo id
  const seen = new Set();
  const uniqueRepos = allRepos.filter(repo => {
    if (seen.has(repo.id)) return false;
    seen.add(repo.id);
    return true;
  });

  console.log(`\n--- Found ${uniqueRepos.length} unique repos. Filtering by contributors & recent issues ---\n`);

  // Phase 2: Filter by contributors (>2) and recent open issues
  const results = [];

  for (let i = 0; i < uniqueRepos.length; i++) {
    const repo = uniqueRepos[i];
    process.stdout.write(`  [${i + 1}/${uniqueRepos.length}] ${repo.full_name} ... `);

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
      console.log(`✗ only ${contributorsCount} contributors`);
    }

    // Small delay between API calls
    if (i % 5 === 4) await sleep(500);
  }

  // Build output with search info header
  const endTime = new Date();
  const output = {
    searchInfo: {
      query: searchQuery,
      executedAt: startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationSeconds: Math.round((endTime - startTime) / 1000),
      totalReposFound: uniqueRepos.length,
      reposMatchedFilters: results.length,
      filters: {
        minContributors: 3,
        requireRecentOpenIssues: true,
        recentIssueWindow: '1 month',
      },
    },
    results: results,
  };

  // Timestamp filename
  const timestamp = startTime.toISOString().replace(/:/g, '-');
  const filename = `${timestamp}.json`;

  fs.writeFileSync(path.join(__dirname, filename), JSON.stringify(output, null, 2));

  console.log(`\n=== Done ===`);
  console.log(`Total repos searched: ${uniqueRepos.length}`);
  console.log(`Repos matched: ${results.length}`);
  console.log(`Duration: ${Math.round((endTime - startTime) / 1000)}s`);
  console.log(`Saved to: ${filename}`);
}

main().catch((error) => {
  console.error('Error running the script:', error);
});
