/**
 * 抓取论坛所有参赛作品数据，存为静态 JSON
 * 由 GitHub Actions 每 5 分钟调用一次
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://forum.trae.cn/c/38-category/40-category/40.json';
const PINNED_IDS = [22549, 21487];
const MAX_PAGES = 80; // 足够大，覆盖所有作品

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

async function main() {
    console.log('Starting data fetch...');

    // 先获取第一页确定是否有数据
    const firstData = await fetchPage(0);
    let allTopics = parseTopics(firstData);

    const hasMore = (firstData.topic_list || {}).more_topics_url;
    console.log(`Page 0: ${allTopics.length} topics, hasMore=${!!hasMore}`);

    if (!hasMore) {
        // 只有一页
        return saveData(allTopics);
    }

    // 并行获取剩余所有页面
    const pages = [];
    for (let p = 1; p < MAX_PAGES; p++) pages.push(p);

    console.log(`Fetching pages 1 to ${MAX_PAGES - 1} in parallel...`);

    const results = await Promise.allSettled(pages.map(p => fetchPage(p)));

    let pagesOk = 0;
    let pagesFail = 0;
    let lastHasMore = true;

    for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
            const data = results[i].value;
            const topics = parseTopics(data);
            allTopics.push(...topics);
            pagesOk++;

            const more = (data.topic_list || {}).more_topics_url;
            if (!more) {
                // 这页之后没更多了，但继续处理已完成的请求
                lastHasMore = false;
            }
        } else {
            pagesFail++;
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
