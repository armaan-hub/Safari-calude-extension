// Job Watcher live activity: plain-English one-line descriptions of claude stream-json events. Built-ins only.
// Never throws: any event that does not have the expected shape gives [].

const SAFARI_PREFIX = 'mcp__safari__';
const TYPED_MAX = 60;
const SAY_MAX = 240;
const RESULT_MAX = 160;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

// navigate and open_tab: host and path only. The query string and fragment are dropped so tokens in URLs are
// never logged. Null when the URL cannot be parsed.
const TAB_PATH_MAX = 60;
function hostAndPath(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  return `${u.hostname}${u.pathname.slice(0, TAB_PATH_MAX)}`;
}

function openTabWords(rawUrl) {
  const hp = hostAndPath(rawUrl);
  return hp ? `opening ${hp} in a new tab` : 'opening a new tab';
}

// Words for one tool call. The mcp__safari__ prefix is stripped first; other tools keep their bare name.
// showTyped false (privacy, terminal source) shows the character count of typed text instead of the text.
export function describeToolCall(rawName, input, opts = {}) {
  const name = rawName.startsWith(SAFARI_PREFIX) ? rawName.slice(SAFARI_PREFIX.length) : rawName;
  const inp = isObj(input) ? input : {};
  switch (name) {
    case 'read_page':
      return 'reading the page';
    case 'get_page_text':
      return 'reading page text';
    case 'click':
      return `clicking ${str(inp.ref) || 'an element'}`;
    case 'type': {
      const ref = str(inp.ref) || 'an element';
      if (opts.showTyped === false) return `typing ${str(inp.text).length} characters into ${ref}`;
      return `typing "${collapse(str(inp.text)).slice(0, TYPED_MAX)}" into ${ref}`;
    }
    case 'press_key':
      return `pressing key ${str(inp.key) || '?'}`;
    case 'scroll':
      if (str(inp.direction)) return `scrolling ${inp.direction}`;
      if (str(inp.ref)) return `scrolling to ${inp.ref}`;
      return 'scrolling';
    case 'navigate':
      return `opening ${hostAndPath(str(inp.url)) ?? 'a page'}`;
    case 'open_tab':
      return openTabWords(str(inp.url));
    case 'wait':
      return Number.isFinite(inp.seconds) ? `waiting ${inp.seconds} s` : 'waiting';
    case 'screenshot':
      return 'taking a screenshot';
    case 'safari_status':
      return 'checking Safari connection';
    default:
      return name;
  }
}

// Text of a tool_result: a plain string, or the text parts of a content array.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => isObj(p) && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

function formatEvent(event, opts) {
  if (!isObj(event) || !isObj(event.message) || !Array.isArray(event.message.content)) return [];
  const tools = opts.tools !== false;
  const out = [];
  for (const block of event.message.content) {
    if (!isObj(block)) continue;
    if (event.type === 'assistant') {
      if (block.type === 'text' && typeof block.text === 'string') {
        const said = collapse(block.text).slice(0, SAY_MAX);
        if (said) out.push(`says: ${said}`);
      } else if (tools && block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
        out.push(describeToolCall(block.name, block.input));
      }
    } else if (tools && event.type === 'user' && block.type === 'tool_result') {
      const text = resultText(block.content);
      // Successful results are noise; failures (including blocked actions) must stay visible.
      if (block.is_error === true || text.trimStart().startsWith('Error:')) {
        out.push(`result: ${collapse(text).slice(0, RESULT_MAX) || 'error'}`);
      }
    }
  }
  return out;
}

// Zero or more plain-English lines for one stream-json event. opts.tools === false keeps only says lines.
// Never throws.
export function formatStreamEvent(event, opts = {}) {
  try {
    return formatEvent(event, isObj(opts) ? opts : {});
  } catch {
    return [];
  }
}
