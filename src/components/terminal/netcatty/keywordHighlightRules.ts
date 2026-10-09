/* 关键字高亮规则 —— 移植自 Netcatty domain/models/terminal.ts（GPL-3.0-or-later），
   默认规则、URL/IP/MAC 模式与 normalize 逻辑逐字保留；中文标签取自 Netcatty zh-CN。 */
export interface KeywordHighlightRule {
  id: string;
  label: string; // Display name (e.g., "Error", "Warning", "OK")
  patterns: string[]; // Regex patterns to match
  color: string; // Highlight color (hex)
  enabled: boolean;
  // Set to true when the user edits a built-in rule's label/patterns so
  // normalize keeps the user-edited values instead of overwriting them with
  // the latest shipped defaults. Absent / false means "still tracking defaults"
  // and the rule picks up new built-in patterns added in later versions.
  customized?: boolean;
}

const STRICT_IPV4_OCTET_PATTERN = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

const URL_HIGHLIGHT_PATTERN =
  "(?:\\bhttps?:\\/\\/\\[[0-9A-Fa-f:.]+\\](?::\\d+)?(?:[/?#][^\\s<>\"'`]*)?(?<![.,;:!?\\)}])|\\b(?:https?:\\/\\/|www\\.)[^\\s<>\"'`]+(?<![.,;:!?\\])}]))";
const IPV4_HIGHLIGHT_PATTERN =
  `(?<![\\w.])(?<!\\bver\\s)(?<!\\bversion\\s)(?:${STRICT_IPV4_OCTET_PATTERN}\\.){3}${STRICT_IPV4_OCTET_PATTERN}(?![\\w.])`;
// Covers full and compressed forms (1:2:3:4:5:6:7:8, fe80::1, ::1, 2001:db8::,
// etc.). Bracketed `[…]:port` URLs are matched by URL_HIGHLIGHT_PATTERN.
// Zone IDs (%eth0) and IPv4-mapped (::ffff:192.0.2.1) are intentionally out
// of scope here — add them as custom patterns if you need them.
const IPV6_HIGHLIGHT_PATTERN =
  '(?<![\\w:.])' +
  '(?:' +
    '(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,7}:' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}' +
    '|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}' +
    '|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}' +
    '|::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}' +
  ')' +
  '(?![\\w:.])';
const MAC_ADDRESS_HIGHLIGHT_PATTERN =
  '\\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\\b';

export const DEFAULT_KEYWORD_HIGHLIGHT_RULES: KeywordHighlightRule[] = [
  { id: 'error', label: 'Error', patterns: ['\\[error\\]', '\\[err\\]', '\\berror\\b', '\\bfail(ed)?\\b', '\\bfatal\\b', '\\bcritical\\b', '\\bexception\\b'], color: '#F87171', enabled: true },
  { id: 'warning', label: 'Warning', patterns: ['\\[warn(ing)?\\]', '\\bwarn(ing)?\\b', '\\bcaution\\b', '\\bdeprecated\\b'], color: '#FBBF24', enabled: true },
  { id: 'ok', label: 'OK', patterns: ['\\[ok\\]', '\\bok\\b', '\\bsuccess(ful)?\\b', '\\bpassed\\b', '\\bcompleted\\b', '\\bdone\\b'], color: '#34D399', enabled: true },
  { id: 'info', label: 'Info', patterns: ['\\[info\\]', '\\[notice\\]', '\\[note\\]', '\\bnotice\\b', '\\bnote\\b'], color: '#3B82F6', enabled: true },
  { id: 'debug', label: 'Debug', patterns: ['\\[debug\\]', '\\[trace\\]', '\\[verbose\\]', '\\bdebug\\b', '\\btrace\\b', '\\bverbose\\b'], color: '#A78BFA', enabled: true },
  { id: 'ip-mac', label: 'URL, IP & MAC', patterns: [URL_HIGHLIGHT_PATTERN, IPV4_HIGHLIGHT_PATTERN, IPV6_HIGHLIGHT_PATTERN, MAC_ADDRESS_HIGHLIGHT_PATTERN], color: '#EC4899', enabled: true },
];

const cloneKeywordHighlightRule = (rule: KeywordHighlightRule): KeywordHighlightRule => ({
  ...rule,
  patterns: [...rule.patterns],
});

export const normalizeKeywordHighlightRules = (
  rules?: KeywordHighlightRule[],
): KeywordHighlightRule[] => {
  if (!rules || rules.length === 0) {
    return DEFAULT_KEYWORD_HIGHLIGHT_RULES.map(cloneKeywordHighlightRule);
  }

  const defaultRulesById = new Map(
    DEFAULT_KEYWORD_HIGHLIGHT_RULES.map((rule) => [rule.id, rule] as const),
  );

  const normalizedRules = rules.map((rule) => {
    const defaultRule = defaultRulesById.get(rule.id);
    if (!defaultRule) {
      return cloneKeywordHighlightRule(rule);
    }

    // A built-in rule the user has explicitly edited keeps its label/patterns;
    // otherwise we re-sync with the latest defaults so newly shipped patterns
    // (e.g. the IPv6 entry in `ip-mac`) propagate to existing users without
    // a manual reset.
    if (rule.customized) {
      return {
        ...defaultRule,
        label: rule.label,
        patterns: [...rule.patterns],
        color: rule.color,
        enabled: rule.enabled,
        customized: true,
      };
    }

    return {
      ...defaultRule,
      color: rule.color,
      enabled: rule.enabled,
    };
  });

  const existingRuleIds = new Set(normalizedRules.map((rule) => rule.id));
  for (const defaultRule of DEFAULT_KEYWORD_HIGHLIGHT_RULES) {
    if (!existingRuleIds.has(defaultRule.id)) {
      normalizedRules.push(cloneKeywordHighlightRule(defaultRule));
    }
  }

  return normalizedRules;
};
