/**
 * Vercel Serverless Function - 获取论坛所有参赛作品数据
 * 一次性并行请求所有页面，最大化速度
 */

const API_BASE = 'https://forum.trae.cn/c/38-category/40-category/40.json';
const PINNED_IDS = [22549, 21487];
const MAX_PAGES = 55;

async function fetchPage(page) {
    const url = `${API_BASE}?page=${page}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(8000)
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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // 第一阶段：获取前2页确定大致页数
        const [page0, page1] = await Promise.all([
            fetchPage(0),
            fetchPage(1).catch(() => null)
        ]);

        const allTopics = [...parseTopics(page0)];
        let maxPage = MAX_PAGES;

        if (page1) {
            allTopics.push(...parseTopics(page1));
            // 如果第1页有更多，说明数据量很大，需要请求更多页
            const more1 = (page1.topic_list || {}).more_topics_url;
            if (!more1) {
                // 只有2页数据
                return res.status(200).json({
                    topics: allTopics,
                    count: allTopics.length,
                    last_update: new Date().toISOString(),
                    loading: false,
                    error: null
                });
            }
        }

        // 第二阶段：并行请求剩余所有页面（page 2 到 maxPage-1）
        const remainingPages = [];
        for (let p = 2; p < maxPage; p++) {
            remainingPages.push(p);
        }

        const results = await Promise.allSettled(remainingPages.map(p => fetchPage(p)));

        for (const result of results) {
            if (result.status === 'fulfilled') {
                allTopics.push(...parseTopics(result.value));
            }
        }

        // 去重（以防有重复topic）
        const seen = new Set();
        const deduped = allTopics.filter(t => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
        });

        return res.status(200).json({
            topics: deduped,
            count: deduped.length,
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
