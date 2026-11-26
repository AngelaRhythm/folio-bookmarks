// Local intelligent bookmark organizer:
// 1) Folder architecture insights tailored to overlapping categories
// 2) Domain & keyword rule-based move suggestions
// 3) Same-domain cross-folder cluster discovery
// 4) Duplicate URL detection

import { getDisplayHost, getRootDomain, normalizeUrl } from './url.js';

const CATEGORY_PROFILES = [
  {
    id: 'inspiration',
    label: '灵感 · Inspiration',
    folderHints: ['视觉灵感', '灵感', '设计', '优秀个站', '个站', '作品集', 'inspiration', 'design', 'gallery', 'ui', 'ux'],
    domains: [
      'dribbble.com', 'behance.net', 'awwwards.com', 'mobbin.com', 'godly.website',
      'minimal.gallery', 'layers.to', 'read.cv', 'cosmos.so', 'pinterest.com',
      'siteinspire.com', 'lapa.ninja', 'framer.gallery', 'curated.design', 'refero.design',
      'screenlane.com', 'httpster.net', 'onepagelove.com', 'dark.design', 'tympanus.net',
      'land-book.com', 'savee.it', 'are.na', 'huaban.com', 'zcool.com.cn'
    ],
    keywords: ['portfolio', 'gallery', 'inspiration', 'motion', 'showcase', '灵感', '作品集', '动效', '排版', '字体', '视觉', '画廊']
  },
  {
    id: 'dev',
    label: '开发 · Dev',
    folderHints: ['code', '开发', '前端', '编程', '规范', '文档', 'dev', 'tech', 'engineering', 'spec'],
    domains: [
      'github.com', 'gitlab.com', 'stackoverflow.com', 'developer.mozilla.org', 'npmjs.com',
      'vitejs.dev', 'react.dev', 'vuejs.org', 'tailwindcss.com', 'typescriptlang.org',
      'nextjs.org', 'astro.build', 'svelte.dev', 'codepen.io', 'codesandbox.io',
      'm3.material.io', 'developer.apple.com', 'ant.design', 'radix-ui.com', 'shadcn.com',
      'ui.shadcn.com', 'web.dev', 'caniuse.com', 'css-tricks.com', 'vercel.com'
    ],
    keywords: ['api', 'sdk', 'docs', 'documentation', 'guideline', 'design system', 'component', '规范', '组件库', '源码', '文档', '前端']
  },
  {
    id: 'tools',
    label: '工具 · Tools',
    folderHints: ['小工具', '工具', '效率', 'tools', 'utility', 'utilities', 'apps'],
    domains: [
      'figma.com', 'excalidraw.com', 'ray.so', 'squoosh.app', 'tinypng.com',
      'svgomg.net', 'remove.bg', 'transform.tools', 'regex101.com', 'jsoncrack.com',
      'coolors.co', 'realtimecolors.com', 'easings.net', 'cubic-bezier.com',
      'lucide.dev', 'heroicons.com', 'iconify.design', 'fonts.google.com', 'unsplash.com',
      'linear.app', 'notion.so', 'loom.com', 'cal.com'
    ],
    keywords: ['generator', 'converter', 'formatter', 'compressor', 'calculator', '在线工具', '生成器', '转换', '压缩', '配色', '图标']
  },
  {
    id: 'ai',
    label: 'AI 社区与工具',
    folderHints: ['ai社区', 'ai', '大模型', 'llm', 'prompt', 'aigc'],
    domains: [
      'huggingface.co', 'openai.com', 'anthropic.com', 'claude.ai', 'chatgpt.com',
      'gemini.google.com', 'aistudio.google.com', 'perplexity.ai', 'midjourney.com',
      'poe.com', 'replicate.com', 'civitai.com', 'theresanaiforthat.com', 'futurepedia.io',
      'waytoagi.com', 'v0.dev', 'cursor.com', 'bolt.new', 'lovable.dev', 'arxiv.org'
    ],
    keywords: ['llm', 'gpt', 'claude', 'gemini', 'agent', 'prompt', 'diffusion', '大模型', '提示词', '智能体']
  },
  {
    id: 'reading',
    label: '阅读 · Reading',
    folderHints: ['论坛博客', '博客', '论坛', '社区', '阅读', '资讯', 'blog', 'forum', 'reading', 'news'],
    domains: [
      'news.ycombinator.com', 'v2ex.com', 'juejin.cn', 'zhihu.com', 'substack.com',
      'medium.com', 'dev.to', 'producthunt.com', 'reddit.com', 'x.com', 'twitter.com',
      'ruanyifeng.com', 'smashingmagazine.com', 'alistapart.com', 'sspai.com', '36kr.com',
      'woshipm.com', 'infoq.cn', 'lobste.rs'
    ],
    keywords: ['blog', 'article', 'newsletter', 'weekly', 'podcast', '周刊', '专栏', '博客', '社区', '论坛']
  },
  {
    id: 'work',
    label: '工作 · Work',
    folderHints: ['公司', '工作', '内部', '项目', 'work', 'company', 'office', 'intranet', 'team'],
    domains: [
      'feishu.cn', 'larkoffice.com', 'dingtalk.com', 'yuque.com', 'atlassian.net',
      'jira.com', 'confluence.com', 'asana.com', 'monday.com', 'slack.com',
      'docs.google.com', 'drive.google.com', 'oa.', 'wiki.', 'gitlab.'
    ],
    keywords: ['oa', 'okr', 'jira', 'wiki', '需求池', '排期', '周报', '审批', '考勤', '内部']
  }
];

function matchFolderToProfile(folderTitle) {
  const lower = (folderTitle || '').toLowerCase();
  for (const profile of CATEGORY_PROFILES) {
    if (profile.folderHints.some((hint) => lower.includes(hint))) {
      return profile;
    }
  }
  return null;
}

function matchBookmarkToProfile(bookmark) {
  const host = getDisplayHost(bookmark.url).toLowerCase();
  const root = getRootDomain(bookmark.url).toLowerCase();
  const titleLower = (bookmark.title || '').toLowerCase();

  for (const profile of CATEGORY_PROFILES) {
    for (const domain of profile.domains) {
      if (domain.endsWith('.')) {
        if (host.startsWith(domain) || host.includes(`.${domain}`)) {
          return { profile, reason: `域名特征 (${host})` };
        }
      } else if (host === domain || host.endsWith(`.${domain}`) || root === domain) {
        return { profile, reason: `站点属于 ${domain}` };
      }
    }
  }

  for (const profile of CATEGORY_PROFILES) {
    for (const kw of profile.keywords) {
      if (titleLower.includes(kw)) {
        return { profile, reason: `标题包含「${kw}」` };
      }
    }
  }

  return null;
}

export function analyzeBookmarks(topFolders, allBookmarks) {
  const structureInsights = [];
  const moveSuggestions = [];
  const domainClusters = [];
  const duplicates = [];

  // Map existing top-level folders to profiles
  const profileToFolders = new Map();
  for (const folder of topFolders) {
    const prof = matchFolderToProfile(folder.title);
    if (prof) {
      if (!profileToFolders.has(prof.id)) profileToFolders.set(prof.id, []);
      profileToFolders.get(prof.id).push(folder);
    }
  }

  // 1. Structure insights: detect overlapping folders (e.g., 视觉灵感 + 优秀个站, Code + 规范)
  const overlapPairs = [
    {
      a: ['视觉灵感', '灵感'],
      b: ['优秀个站', '个站', '作品集'],
      title: '合并「视觉灵感」与「优秀个站」为统一灵感画廊',
      detail: '这两个文件夹在浏览心智上高度重合，建议以「视觉灵感」作为一级目录，将「优秀个站」作为其子文件夹，逛灵感时无需来回切换。',
      actionType: 'nest',
      parentHint: ['视觉灵感', '灵感'],
      childHint: ['优秀个站', '个站', '作品集']
    },
    {
      a: ['code', '开发', '前端'],
      b: ['规范', '设计规范', '文档'],
      title: '将「规范」收拢进「Code / 开发」场景',
      detail: '编码与查规范通常发生在同一工作流中，把「规范」设为「Code」的子目录可以减少顶层分类跳转。',
      actionType: 'nest',
      parentHint: ['code', '开发', '前端'],
      childHint: ['规范', '设计规范', '文档']
    },
    {
      a: ['论坛博客', '博客', '论坛'],
      b: ['ai社区', 'ai'],
      title: '区分「AI 资讯阅读」与「AI 效率工具」',
      detail: '「AI社区」里的讨论站适合与「论坛博客」一起归为阅读场景；而高频使用的 AI 工具站更适合放进「小工具」。',
      actionType: 'info'
    }
  ];

  for (const pair of overlapPairs) {
    const folderA = topFolders.find((f) => pair.a.some((h) => f.title.toLowerCase().includes(h)));
    const folderB = topFolders.find((f) => f.id !== folderA?.id && pair.b.some((h) => f.title.toLowerCase().includes(h)));
    if (folderA && folderB) {
      structureInsights.push({
        id: `overlap-${folderA.id}-${folderB.id}`,
        title: pair.title,
        detail: pair.detail,
        actionType: pair.actionType,
        parentFolder: folderA,
        childFolder: folderB
      });
    }
  }

  // Check loose root bookmarks (Inbox recommendation)
  const looseBookmarks = allBookmarks.filter((b) => b.isRootLoose);
  if (looseBookmarks.length >= 2) {
    structureInsights.push({
      id: 'loose-inbox',
      title: `书签栏根目录有 ${looseBookmarks.length} 个未归类书签`,
      detail: '建议建立一个「收集箱」文件夹承接临时收藏，保持顶层分类长期清爽。',
      actionType: 'create_inbox',
      looseIds: looseBookmarks.map((b) => b.id)
    });
  }

  // Check oversized folders
  for (const folder of topFolders) {
    if (folder.totalCount >= 35 && (!folder.subfolders || folder.subfolders.length === 0)) {
      structureInsights.push({
        id: `oversized-${folder.id}`,
        title: `「${folder.title}」已累积 ${folder.totalCount} 个书签`,
        detail: '单个平铺文件夹超过 35 项时检索效率会下降，建议在其中拆分 2 至 3 个子文件夹。',
        actionType: 'info'
      });
    }
  }

  // 2. Smart move suggestions for misplaced or loose bookmarks
  for (const bm of allBookmarks) {
    const match = matchBookmarkToProfile(bm);
    if (!match) continue;

    const currentTopFolder = topFolders.find((f) => f.id === bm.topFolderId);
    const currentProfile = currentTopFolder ? matchFolderToProfile(currentTopFolder.title) : null;

    // Skip if already in matching category folder
    if (currentProfile && currentProfile.id === match.profile.id) continue;

    // Find best existing target folder for this matched profile
    const candidateFolders = profileToFolders.get(match.profile.id);
    if (!candidateFolders || candidateFolders.length === 0) continue;

    const targetFolder = candidateFolders[0];
    if (targetFolder.id === bm.parentId) continue;

    moveSuggestions.push({
      bookmark: bm,
      targetFolder,
      reason: match.reason,
      fromLabel: bm.folderPath || '书签栏根目录'
    });
  }

  // 3. Same-domain clusters scattered across multiple top folders
  const domainMap = new Map();
  for (const bm of allBookmarks) {
    const domain = getRootDomain(bm.url);
    if (!domain) continue;
    if (!domainMap.has(domain)) domainMap.set(domain, []);
    domainMap.get(domain).push(bm);
  }
  for (const [domain, items] of domainMap.entries()) {
    const distinctFolders = new Map();
    for (const item of items) {
      const fid = item.topFolderId || 'root';
      if (!distinctFolders.has(fid)) {
        distinctFolders.set(fid, {
          id: fid,
          title: item.topFolderTitle || '书签栏根目录',
          items: []
        });
      }
      distinctFolders.get(fid).items.push(item);
    }
    if (distinctFolders.size >= 2 && items.length >= 2) {
      const sortedFolders = Array.from(distinctFolders.values()).sort((a, b) => b.items.length - a.items.length);
      domainClusters.push({
        domain,
        total: items.length,
        primaryFolder: sortedFolders[0],
        folders: sortedFolders,
        items
      });
    }
  }
  domainClusters.sort((a, b) => b.total - a.total);

  // 4. Duplicate URL detection
  const normMap = new Map();
  for (const bm of allBookmarks) {
    const key = normalizeUrl(bm.url);
    if (!key) continue;
    if (!normMap.has(key)) normMap.set(key, []);
    normMap.get(key).push(bm);
  }
  for (const [key, items] of normMap.entries()) {
    if (items.length > 1) {
      // Keep the oldest or deepest-organized one first
      const sorted = [...items].sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
      duplicates.push({
        key,
        url: sorted[0].url,
        title: sorted[0].title,
        items: sorted
      });
    }
  }

  return {
    structureInsights,
    moveSuggestions: moveSuggestions.slice(0, 24),
    domainClusters: domainClusters.slice(0, 12),
    duplicates
  };
}
