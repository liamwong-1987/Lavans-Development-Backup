/**
 * promptComposer.js v3 — 合并用户提示词与系统规则
 */
function buildSystemRules(hex, rgb, lab, hasMask) {
  const color = `Target: HEX ${hex}, RGB ${rgb.join(',')}, LAB: L${lab[0]} A${lab[1]} B${lab[2]}`;
  let rules = `Perform a localized color edit only.

Change only the bedding fabric to the confirmed target color.

${color}

Preserve every non-bedding object exactly.
Preserve all text, logos and labels content and colors exactly as-is.
Preserve foreground, background, environment,
lighting, shadows, highlights, reflections, perspective and composition.

Preserve the bedding shape, quantity, arrangement, folds, seams,
edges, texture and material appearance.

Do not add, remove, move, replace, rewrite or redesign anything.
Only adjust the color of the existing bedding fabric.`;

  if (hasMask) {
    rules += `\n\nOnly modify pixels inside the editable mask.`;
  }
  return rules;
}

function injectColorToPrompt(userPrompt, hex, rgb, lab, colorName, hasMask, extraPrompt) {
  const userPart = (userPrompt || '').trim();
  const systemPart = buildSystemRules(hex, rgb, lab, hasMask);
  let prompt = userPart ? `${userPart}\n\n${systemPart}` : systemPart;
  // 追加用户额外提示词
  const extra = (extraPrompt || '').trim();
  if (extra) {
    prompt += `\n\nAdditional user instructions:\n${extra}`;
  }
  return prompt;
}

function composeCorrection(userPrompt, hex, rgb, lab, qcHint, round, hasMask) {
  const userPart = (userPrompt || '').trim();
  return `[Auto-Correction Round ${round}] Previous attempt had deviation: ${qcHint}. Correct only the bedding fabric color (do NOT change text colors or text content).

Target: HEX ${hex}, RGB ${rgb.join(',')}, LAB: L${lab[0]} A${lab[1]} B${lab[2]}

Do not change structure, objects, text content or text color. Only adjust bedding fabric pixel colors.${hasMask ? '\nOnly modify pixels inside the editable mask.' : ''}

${userPart}`;
}

module.exports = { injectColorToPrompt, composeCorrection, buildSystemRules };
