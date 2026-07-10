/**
 * 抓取论坛所有参赛作品数据，存为静态 JSON
 * 由 GitHub Actions 每 5 分钟调用一次
 *
 * 策略：
 *   1. 串行获取前几页，同时根据 more_topics_url 判断是否还有更多
 *   2. 二分法探测总页数
 *   3. 分批并行请求（每批10页），避免连接被拒绝
 *   4. 去重后保存
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://forum.trae.cn/c/38-category/40-category/40.json';
const PINNED_IDS = [22549, 21487];
const BATCH_SIZE = 10; // 每批并行请求数

async function fetchPage(page) {
    const url = `${API_BASE}?page=${page}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
    return res.json();
}

function parseTopics(data) {
    const users = data.users || [];
    const topics = (data.topic_list || {}).topics || [];

    return topics
        .filter(t => {
            if (PINNED_IDS.includes(t.id)) return false;
            if (t.title === '关于大赛初赛专区') return false;
            const excerpt = t.excerpt || '';
            if (excerpt.includes('已被作者删除')) return false;
            return true;
        })
        .map(t => {
            let username = '';
            const posters = t.posters || [];
            if (posters.length > 0) {
                const posterUid = posters[0].user_id;
                const user = users.find(u => u.id === posterUid);
                if (user) username = user.username || '';
            }

            return {
                id: t.id,
                title: t.title || '',
                slug: t.slug || 'topic',
                vote_count: t.vote_count || 0,
                like_count: t.like_count || 0,
                views: t.views || 0,
                reply_count: t.reply_count || 0,
                tags: (t.tags || []).map(tag => tag.name || ''),
                username,
                created_at: t.created_at || ''
            };
        });
}

/**
 * 二分法探测最后一个有数据的页码
 */
async function findLastPage() {
    let lo = 0;
    let hi = 512; // 上限设大一些

    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        try {
            const data = await fetchPage(mid);
            const topics = (data.topic_list || {}).topics || [];
            if (topics.length > 0) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        } catch (e) {
            hi = mid - 1;
        }
    }

    return lo;
}

/**
 * 分批并行请求，每批 BATCH_SIZE 页
 */
async function fetchPagesBatch(pages) {
    const allResults = [];

    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
        const batch = pages.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(batch.map(p => fetchPage(p)));

        for (let j = 0; j < results.length; j++) {
            allResults.push({ page: batch[j], result: results[j] });
        }

        // 进度日志
        const done = Math.min(i + BATCH_SIZE, pages.length);
        console.log(`Progress: ${done}/${pages.length} pages requested`);
    }

    return allResults;
}

async function main() {
    console.log('Starting data fetch...');

    // 第一阶段：获取第一页
    const firstData = await fetchPage(0);
    let allTopics = parseTopics(firstData);
    const hasMore = (firstData.topic_list || {}).more_topics_url;
    console.log(`Page 0: ${allTopics.length} topics, hasMore=${!!hasMore}`);

    if (!hasMore) {
        return saveData(allTopics);
    }

    // 第二阶段：二分探测总页数
    console.log('Detecting total pages via binary search...');
    const lastPage = await findLastPage();
    console.log(`Last page with data: ${lastPage}`);

    // 第三阶段：分批并行请求 page 1 到 lastPage
    const pages = [];
    for (let p = 1; p <= lastPage; p++) pages.push(p);

    console.log(`Fetching pages 1 to ${lastPage} in batches of ${BATCH_SIZE}...`);

    const allResults = await fetchPagesBatch(pages);

    let pagesOk = 0;
    let pagesFail = 0;
    const failedPages = [];

    for (const { page, result } of allResults) {
        if (result.status === 'fulfilled') {
            const topics = parseTopics(result.value);
            allTopics.push(...topics);
            pagesOk++;
        } else {
            pagesFail++;
            failedPages.push(page);
        }
    }

    // 如果有失败的页面，重试一次
    if (failedPages.length > 0) {
        console.log(`Retrying ${failedPages.length} failed pages...`);
        const retryResults = await fetchPagesBatch(failedPages);

        for (const { page, result } of retryResults) {
            if (result.status === 'fulfilled') {
                const topics = parseTopics(result.value);
                allTopics.push(...topics);
                pagesOk++;
                pagesFail--;
            }
        }
    }

    // 去重
    const seen = new Set();
    const deduped = allTopics.filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
    });

    console.log(`Fetched: ${pagesOk} pages ok, ${pagesFail} failed, ${deduped.length} unique topics`);

    return saveData(deduped);
}

function saveData(topics) {
    const output = {
        topics,
        count: topics.length,
        last_update: new Date().toISOString(),
        error: null
    };

    const outDir = path.join(__dirname, '..', 'public');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, 'data.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');

    console.log(`Saved ${topics.length} topics to ${outPath}`);
    console.log(`Last update: ${output.last_update}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
