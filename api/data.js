/**
 * Vercel Serverless Function - 获取论坛所有参赛作品数据
 * 通过并行请求加速数据获取
 */

const API_BASE = 'https://forum.trae.cn/c/38-category/40-category/40.json';
const PINNED_IDS = [22549, 21487];
const MAX_PAGES = 50;
const BATCH_SIZE = 10; // 并行请求批次大小

async function fetchPage(page) {
    const url = `${API_BASE}?page=${page}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

async function fetchBatch(pages) {
    const results = await Promise.allSettled(pages.map(p => fetchPage(p)));
    const allTopics = [];
    let lastPage = -1;

    for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
            const data = results[i].value;
            allTopics.push(...parseTopics(data));
            lastPage = pages[i];

            // 检查是否还有更多
            const moreUrl = (data.topic_list || {}).more_topics_url;
            if (!moreUrl) {
                return { topics: allTopics, hasMore: false };
            }
        }
    }

    return { topics: allTopics, hasMore: true, lastPage };
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // 先获取第一页，确定总页数
        const firstData = await fetchPage(0);
        const firstTopics = parseTopics(firstData);
        const hasMore = (firstData.topic_list || {}).more_topics_url;

        if (!hasMore) {
            return res.status(200).json({
                topics: firstTopics,
                count: firstTopics.length,
                last_update: new Date().toISOString(),
                loading: false,
                error: null
            });
        }

        // 并行批量获取剩余页面
        const allTopics = [...firstTopics];
        let startPage = 1;
        let continueFetching = true;

        while (continueFetching && startPage < MAX_PAGES) {
            const pages = [];
            for (let i = 0; i < BATCH_SIZE && startPage + i < MAX_PAGES; i++) {
                pages.push(startPage + i);
            }

            const batchResult = await fetchBatch(pages);
            allTopics.push(...batchResult.topics);

            if (!batchResult.hasMore || pages[pages.length - 1] >= MAX_PAGES - 1) {
                continueFetching = false;
            } else {
                startPage += BATCH_SIZE;
            }
        }

        return res.status(200).json({
            topics: allTopics,
            count: allTopics.length,
            last_update: new Date().toISOString(),
            loading: false,
            error: null
        });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({
            topics: [],
            count: 0,
            last_update: new Date().toISOString(),
            loading: false,
            error: error.message
        });
    }
}
