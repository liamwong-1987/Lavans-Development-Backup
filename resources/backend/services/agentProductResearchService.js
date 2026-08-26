const crypto = require('crypto');

function safeText(value, limit = 12000) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function lines(value, limit = 80) {
  return [...new Set(safeText(value, 20000).split(/\r?\n|[；;]/).map(item => item.replace(/^[-*•\d.、)\s]+/, '').trim()).filter(Boolean))].slice(0, limit);
}

function sourceId(value) {
  const clean = safeText(value, 160).replace(/[^a-zA-Z0-9_-]/g, '');
  return clean || `source_${crypto.createHash('sha1').update(safeText(value, 500)).digest('hex').slice(0, 12)}`;
}

function normalizedMaterials(run) {
  return (Array.isArray(run?.materials) ? run.materials : []).slice(0, 20).map((item, index) => {
    const previewText = safeText(item?.previewText, 16000);
    const archiveEntries = (Array.isArray(item?.archiveEntries) ? item.archiveEntries : []).slice(0, 200).map(value => safeText(value, 300)).filter(Boolean);
    const kind = safeText(item?.kind || 'file', 40);
    const extension = safeText(item?.extension, 20).toLowerCase();
    const formalDocument = ['document', 'pdf', 'text'].includes(kind) || ['.doc', '.docx', '.pdf', '.md', '.txt', '.json', '.csv', '.xlsx', '.pptx'].includes(extension);
    const evidenceGrade = formalDocument && previewText.length >= 20 ? 'A' : (kind === 'image' || formalDocument || archiveEntries.length ? 'B' : 'C');
    return {
      id: sourceId(item?.id || `material-${index + 1}`),
      name: safeText(item?.name || item?.originalName || `资料 ${index + 1}`, 240),
      kind,
      extension,
      mime: safeText(item?.mime, 100),
      size: Math.max(0, Number(item?.size) || 0),
      url: safeText(item?.url, 800),
      evidenceGrade,
      readable: previewText.length > 0,
      previewText,
      archiveEntries
    };
  });
}

function evidenceChoices(run) {
  return lines(run?.questionnaireAnswers?.evidence, 40).map((label, index) => ({
    id: `declared-evidence-${index + 1}`,
    name: label,
    kind: 'user-declared-evidence',
    evidenceGrade: 'B',
    readable: false
  }));
}

function conflictKey(statement) {
  const match = safeText(statement, 1000).match(/^(.{1,32}?)[：:]\s*(.+)$/);
  return match ? { key: match[1].replace(/\s+/g, '').toLowerCase(), value: match[2].trim() } : null;
}

function findConflicts(statements) {
  const byKey = new Map();
  statements.forEach(statement => {
    const parsed = conflictKey(statement);
    if (!parsed) return;
    if (!byKey.has(parsed.key)) byKey.set(parsed.key, new Map());
    byKey.get(parsed.key).set(parsed.value, statement);
  });
  return [...byKey.entries()].filter(([, values]) => values.size > 1).map(([key, values]) => ({
    key,
    statements: [...values.values()],
    status: 'requires-user-decision'
  }));
}

function buildEvidenceLedger(run) {
  const materials = normalizedMaterials(run);
  const declaredEvidence = evidenceChoices(run);
  const sources = [...materials.map(({ previewText, archiveEntries, ...source }) => ({ ...source, previewLength: previewText.length, archiveEntryCount: archiveEntries.length })), ...declaredEvidence];
  const strongestGrade = sources.some(source => source.evidenceGrade === 'A') ? 'A' : sources.some(source => source.evidenceGrade === 'B') ? 'B' : 'C';
  const statements = lines(run?.questionnaireAnswers?.facts, 120);
  const claims = statements.map((text, index) => ({
    id: `fact-${String(index + 1).padStart(3, '0')}`,
    text,
    evidenceGrade: strongestGrade,
    evidenceRefs: sources.map(source => source.id).slice(0, 20),
    status: strongestGrade === 'A' ? 'evidence-readable-needs-user-lock' : strongestGrade === 'B' ? 'source-declared-needs-user-lock' : 'user-statement-needs-evidence'
  }));
  const prohibitedClaims = lines(run?.questionnaireAnswers?.prohibitedClaims, 80).map((text, index) => ({ id: `prohibited-${index + 1}`, text, enforcement: 'hard-block' }));
  return {
    schemaVersion: 1,
    productName: safeText(run?.questionnaireAnswers?.productName, 500),
    sources,
    materials: materials.map(item => ({ id: item.id, name: item.name, evidenceGrade: item.evidenceGrade, readable: item.readable, previewText: item.previewText, archiveEntries: item.archiveEntries })),
    claims,
    conflicts: findConflicts(statements),
    prohibitedClaims,
    gradingRules: {
      A: '正式资料且本地可读取正文；仍需用户锁定后才能进入后续创作',
      B: '用户声明的证据类型、图片或不可读取正文的正式资料；只能作为待确认来源',
      C: '仅有用户口述，缺少可核对资料；禁止自动扩写为已证实卖点'
    },
    generatedAt: Date.now()
  };
}

function buildFactLockMarkdown(run, ledger) {
  const claimLines = ledger.claims.length ? ledger.claims.map(item => `- [${item.evidenceGrade}] ${item.text}（${item.status}）`).join('\n') : '- 暂无可锁定产品事实；后续创作必须阻塞';
  const conflictLines = ledger.conflicts.length ? ledger.conflicts.map(item => `- ${item.key}：${item.statements.join(' / ')}（需要用户选择）`).join('\n') : '- 未发现结构化字段冲突';
  const prohibitedLines = ledger.prohibitedClaims.length ? ledger.prohibitedClaims.map(item => `- ${item.text}`).join('\n') : '- 未提供具体禁说项；仍须执行通用事实与合规检查';
  const materialLines = ledger.sources.length ? ledger.sources.map(item => `- [${item.evidenceGrade}] ${item.name}${item.readable ? '（正文可本地读取）' : ''}`).join('\n') : '- 未提交可核对资料';
  return `# 产品事实锁（待用户审核）\n\n## 产品名称\n\n${ledger.productName || '等待用户确认'}\n\n## 待锁定事实\n\n${claimLines}\n\n## 资料与证据等级\n\n${materialLines}\n\n## 冲突检查\n\n${conflictLines}\n\n## 禁说项\n\n${prohibitedLines}\n\n## 后续强制边界\n\n- 只有本文件经“提交审核→批准→锁定”后，阶段 3 才能使用其中事实。\n- 不得把 B/C 级来源自动改写为检测结论、认证、功效、价格或比较性主张。\n- 产品实拍图、Logo、包装文字、型号、成分和认证标识必须保持原样，不得凭空补全。\n`;
}

function abstractStoryMechanisms(raw) {
  const results = (Array.isArray(raw?.results) ? raw.results : []).slice(0, 12);
  const corpus = results.map(item => safeText(item?.excerpt, 700)).join('\n');
  const rules = [
    ['误会、错认或信息差触发冲突', /误会|误把|错认|拿错|送错|信息差/],
    ['人物追问推动信息逐步揭示', /追问|质问|询问|盘问/],
    ['日常物件成为剧情触发道具', /作业|蛋糕|资料|备忘录|冰箱|快递|纸条|钥匙/],
    ['第三方行为或旧事造成关系变化', /同学|邻居|主管|室友|老师|朋友|家人/],
    ['结尾通过新证据完成反转或回扣', /最终|最后|发现|揭开|原来|真相/],
    ['少场景、少角色、低成本可拍摄', /./]
  ];
  return {
    sourceCount: results.length,
    abstractMechanismTags: [...new Set(rules.filter(([, pattern]) => pattern.test(corpus)).map(([tag]) => tag))].slice(0, 12),
    privacy: '只保存本地规则提炼的抽象机制；不包含源文件名、正文、摘录或专有表达'
  };
}

function buildOfflineResearch(run, dependency, searches = {}) {
  const available = dependency?.codeAvailable === true && dependency?.databaseAvailable === true;
  const healthy = searches?.health?.ok === true && searches?.health?.network_used === false;
  const topic = abstractStoryMechanisms(searches?.topic);
  const mechanism = abstractStoryMechanisms(searches?.mechanism);
  const status = available && healthy ? 'completed' : 'blocked';
  return {
    schemaVersion: 1,
    status,
    productName: safeText(run?.questionnaireAnswers?.productName, 500),
    dependency: {
      codeAvailable: dependency?.codeAvailable === true,
      databaseAvailable: dependency?.databaseAvailable === true,
      networkUsed: false,
      message: safeText(dependency?.message, 1000)
    },
    health: healthy ? { ok: true, runtime: safeText(searches.health.runtime, 80), networkUsed: false, canonicalScripts: Math.max(0, Number(searches.health.canonical_scripts) || 0), indexedScripts: Math.max(0, Number(searches.health.indexed_scripts) || 0) } : null,
    searches: {
      topicAndRelationship: topic,
      hookRhythmPlacement: mechanism
    },
    blockedReason: status === 'blocked' ? safeText(dependency?.message || '缺少可用的本地授权故事数据库', 1000) : '',
    externalModelUsed: false,
    networkUsed: false,
    generatedAt: Date.now()
  };
}

function buildResearchBoundary(run, ledger, offlineResearch) {
  return {
    schemaVersion: 1,
    productName: ledger.productName,
    status: 'awaiting-user-review',
    allowedSources: [
      '本次问卷中由用户明确填写的内容',
      '本次上传且保留稳定资料 ID 的产品资料',
      '拥有合法使用权的本地故事数据库所提炼的抽象机制标签'
    ],
    prohibitedSources: [
      '未经用户授权的在线搜索或第三方资料上传',
      '无法追溯到事实锁的功效、数据、认证、价格、包装文字或比较性主张',
      '本地故事库中的原文、文件名、摘录、专有表达或事件链复刻'
    ],
    prohibitedClaims: ledger.prohibitedClaims.map(item => item.text),
    unresolvedConflicts: ledger.conflicts,
    offlineResearchStatus: offlineResearch.status,
    networkUsed: false,
    externalModelUsed: false,
    stage3UnlockConditions: [
      '产品事实锁必须为 locked + current',
      '调研边界必须为 locked + current',
      '存在冲突时必须由用户选择唯一口径',
      '本地故事库缺失时不得伪造检索结果或进入依赖该结果的创作'
    ],
    generatedAt: Date.now()
  };
}

function createProductResearchPackage(run, dependency, searches = {}) {
  const evidenceLedger = buildEvidenceLedger(run);
  const factLockMarkdown = buildFactLockMarkdown(run, evidenceLedger);
  const offlineResearch = buildOfflineResearch(run, dependency, searches);
  const researchBoundary = buildResearchBoundary(run, evidenceLedger, offlineResearch);
  return { evidenceLedger, factLockMarkdown, offlineResearch, researchBoundary };
}

module.exports = {
  abstractStoryMechanisms,
  buildEvidenceLedger,
  buildFactLockMarkdown,
  buildOfflineResearch,
  buildResearchBoundary,
  createProductResearchPackage,
  findConflicts,
  normalizedMaterials
};
