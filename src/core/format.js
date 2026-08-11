function scalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function lines(value, depth = 0, key = null) {
  const pad = '  '.repeat(depth);
  const prefix = key === null ? '' : `${key}:`;
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${prefix} []`];
    const out = key === null ? [] : [`${pad}${prefix}`];
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const child = lines(item, depth + 1);
        out.push(
          `${pad}  -${child[0].trimStart() ? ` ${child[0].trimStart()}` : ''}`,
          ...child.slice(1).map((line) => `${pad}    ${line.trimStart()}`),
        );
      } else out.push(`${pad}  - ${scalar(item)}`);
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${pad}${prefix} {}`];
    const out = key === null ? [] : [`${pad}${prefix}`];
    for (const [childKey, child] of entries) {
      if (child !== null && typeof child === 'object') out.push(...lines(child, depth + (key === null ? 0 : 1), childKey));
      else out.push(`${'  '.repeat(depth + (key === null ? 0 : 1))}${childKey}: ${scalar(child)}`);
    }
    return out;
  }
  return [`${pad}${prefix} ${scalar(value)}`];
}

export function formatResult(result, format = 'compact') {
  if (format === 'json') return `${JSON.stringify(result)}\n`;
  return `${lines(result).join('\n')}\n`;
}
