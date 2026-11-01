type FormatterContext = Record<string, unknown>;

export function renderAioStreamsFormat(
  template: string,
  stream: Record<string, unknown>
): string {
  const REMOVE_LINE = "\u0000AIOSTREAMS_REMOVE_LINE\u0000";
  const service = stream.service && typeof stream.service === "object"
    ? stream.service as Record<string, unknown>
    : {};
  const context: FormatterContext = {
    stream,
    service: {
      ...service,
      cached: service.cached ?? stream.cached
    },
    addon: {},
    metadata: {},
    user: {},
    config: {},
    track: {},
    debug: {
      json: JSON.stringify(stream),
      jsonf: JSON.stringify(stream, null, 2)
    },
    tools: { newLine: "\n", removeLine: REMOVE_LINE }
  };

  const stringify = (value: unknown): string => {
    if (value == null) return "";
    if (Array.isArray(value)) return value.map(stringify).join(", ");
    if (typeof value === "object") return "[object Object]";
    return String(value);
  };
  const hasValue = (value: unknown): boolean =>
    value !== undefined && value !== null &&
    (typeof value !== "string" || /\S/.test(value)) &&
    (!Array.isArray(value) || value.length > 0);
  const getProperty = (object: unknown, key: string): unknown => {
    if (!object || typeof object !== "object") return undefined;
    const record = object as Record<string, unknown>;
    const actualKey = Object.keys(record).find(
      item => item.toLowerCase() === key.toLowerCase()
    );
    return actualKey === undefined ? undefined : record[actualKey];
  };
  const inferResolution = (): unknown => {
    const source = stringify(stream.title ?? stream.name ?? "");
    const match = source.match(/(?:2160|1440|1080|720|576|480|360|240|144)p|4k|uhd|qhd|fhd|hd/i);
    return match?.[0];
  };
  const getPath = (path: string, currentContext: FormatterContext): unknown => {
    const parts = path.replace(/\s+/g, "").split(".");
    if (parts.length < 2) return undefined;
    const section = parts.shift()!.toLowerCase();
    const object = getProperty(currentContext, section);
    const key = parts.shift()?.toLowerCase();
    let value: unknown;
    if (section === "stream" && key) {
      const aliases: Record<string, unknown> = {
        title: stream.title ?? stream.name,
        resolution: stream.resolution ?? stream.quality ?? inferResolution(),
        size: stream.size ?? stream.fileSize,
        cached: stream.cached ?? service.cached,
        audioTags: stream.audioTags ?? stream.audio ?? stream.audioCodec,
        languages: stream.languages ?? stream.language,
        subtitles: stream.subtitles ?? stream.subtitle,
        name: stream.name ?? stream.title
      };
      value = Object.prototype.hasOwnProperty.call(aliases, key)
        ? aliases[key]
        : getProperty(object, key);
    } else {
      value = key ? getProperty(object, key) : object;
    }
    for (const part of parts) {
      value = getProperty(value, part);
    }
    return value;
  };
  const splitTopLevel = (value: string, separator: string): string[] => {
    const result: string[] = [];
    let start = 0;
    let quote = "";
    let escaped = false;
    let braces = 0;
    let parentheses = 0;
    let brackets = 0;
    for (let index = 0; index < value.length; index++) {
      const character = value[index]!;
      if (character === "{" && !escaped) {
        braces++;
        continue;
      }
      if (character === "}" && braces > 0 && !escaped) {
        braces--;
        continue;
      }
      if (braces > 0) continue;
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === "(") parentheses++;
      else if (character === ")" && parentheses > 0) parentheses--;
      else if (character === "[") brackets++;
      else if (character === "]" && brackets > 0) brackets--;
      if (
        parentheses === 0 && brackets === 0 &&
        value.startsWith(separator, index)
      ) {
        result.push(value.slice(start, index));
        start = index + separator.length;
        index += separator.length - 1;
      }
    }
    result.push(value.slice(start));
    return result;
  };
  const unquote = (value: string): string => {
    const trimmed = value.trim();
    if (
      trimmed.length < 2 ||
      !((trimmed[0] === "'" && trimmed.at(-1) === "'") ||
        (trimmed[0] === '"' && trimmed.at(-1) === '"'))
    ) return trimmed;
    return trimmed.slice(1, -1)
      .replace(/\\([\\"'])/g, "$1")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  };
  const parseArguments = (value: string, currentContext = context): unknown[] =>
    value.trim() ? splitTopLevel(value, ",").map(item => parseArgument(item, currentContext)) : [];
  const parseArgument = (value: string, currentContext = context): unknown => {
    const trimmed = value.trim();
    if (/^(['"]).*\1$/s.test(trimmed)) return unquote(trimmed);
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return evaluateExpression(trimmed.slice(1, -1), currentContext);
    }
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
    return trimmed;
  };
  const languageCodes: Record<string, string> = {
    arabic: "AR", chinese: "ZH", dutch: "NL", english: "EN", french: "FR",
    german: "DE", hindi: "HI", italian: "IT", japanese: "JA", korean: "KO",
    portuguese: "PT", russian: "RU", spanish: "ES", tamil: "TA", telugu: "TE",
    thai: "TH", turkish: "TR", ukrainian: "UK", vietnamese: "VI",
    ara: "AR", chi: "ZH", zho: "ZH", dut: "NL", nld: "NL", eng: "EN",
    fre: "FR", fra: "FR", ger: "DE", deu: "DE", hin: "HI", ita: "IT",
    jpn: "JA", kor: "KO", por: "PT", rus: "RU", spa: "ES", tam: "TA",
    tel: "TE", tha: "TH", tur: "TR", ukr: "UK", vie: "VI"
  };
  const languageEmojis: Record<string, string> = {
    ar: "🇸🇦", de: "🇩🇪", en: "🇬🇧", es: "🇪🇸", fr: "🇫🇷", hi: "🇮🇳",
    it: "🇮🇹", ja: "🇯🇵", ko: "🇰🇷", nl: "🇳🇱", pt: "🇵🇹", ru: "🇷🇺",
    ta: "🇮🇳", te: "🇮🇳", th: "🇹🇭", tr: "🇹🇷", uk: "🇺🇦", vi: "🇻🇳", zh: "🇨🇳"
  };
  const languageCode = (value: unknown): string => {
    const text = stringify(value).trim();
    const code = languageCodes[text.toLowerCase()] ?? text;
    return code.toUpperCase().slice(0, 3);
  };
  const languageEmoji = (value: unknown): string =>
    languageEmojis[languageCode(value).toLowerCase()] ?? "";
  const mapValue = (
    value: unknown,
    mapper: (item: unknown) => string
  ): unknown => Array.isArray(value) ? value.map(mapper) : mapper(value);
  const formatBytes = (number: number, base: number, concise: boolean, rounded: boolean): string => {
    const units = base === 1024
      ? ["B", "KiB", "MiB", "GiB", "TiB"]
      : ["B", "KB", "MB", "GB", "TB"];
    let amount = Math.abs(number);
    let unit = 0;
    while (amount >= base && unit < units.length - 1) {
      amount /= base;
      unit++;
    }
    if (number < 0) amount *= -1;
    if (rounded) amount = Math.round(amount);
    else if (!concise && unit > 0) amount = Number(amount.toFixed(2));
    else if (concise && unit > 0) amount = Number(amount.toFixed(1));
    return `${amount} ${units[unit]}`;
  };
  const durationPattern = (milliseconds: number, pattern: string): string => {
    const total = Math.max(0, Math.floor(milliseconds / 1000));
    const values: Record<string, number> = {
      H: Math.floor(total / 3600),
      M: Math.floor(total / 60) % 60,
      S: total % 60
    };
    if (!/%-?H/.test(pattern)) values.M = Math.floor(total / 60);
    if (!/%-?H/.test(pattern) && !/%-?M/.test(pattern)) values.S = total;
    const render = (part: string): string => part.replace(/\[([^\[\]]*)\]/g, (_group, contents: string) => {
      const tokens = [...contents.matchAll(/%-?([HMS])/g)];
      return tokens.length && tokens.every(([, token]) => values[token!] === 0)
        ? ""
        : render(contents);
    }).replace(/%%|%-?([HMS])/g, (token, unit: string | undefined) => {
      if (token === "%%") return "%";
      if (!unit) return token;
      const number = values[unit] ?? 0;
      return token.startsWith("%-") ? String(number) : String(number).padStart(2, "0");
    });
    return render(pattern);
  };
  const datePattern = (value: unknown, pattern: string): string => {
    const text = stringify(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const date = new Date(`${text}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return text;
    const day = date.getUTCDate();
    const ordinal = day % 10 === 1 && day % 100 !== 11 ? "st"
      : day % 10 === 2 && day % 100 !== 12 ? "nd"
        : day % 10 === 3 && day % 100 !== 13 ? "rd" : "th";
    const values: Record<string, string> = {
      Y: String(date.getUTCFullYear()), y: String(date.getUTCFullYear()).slice(-2),
      m: String(date.getUTCMonth() + 1).padStart(2, "0"),
      "-m": String(date.getUTCMonth() + 1),
      B: date.toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
      b: date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      d: String(day).padStart(2, "0"), "-d": String(day), o: `${day}${ordinal}`,
      A: date.toLocaleString("en-US", { weekday: "long", timeZone: "UTC" }),
      a: date.toLocaleString("en-US", { weekday: "short", timeZone: "UTC" })
    };
    const optionalPattern = pattern.replace(/\[([^\[\]]*)\]/g, (_group, contents: string) => {
      const tokens = [...contents.matchAll(/%-?([YymBbd oAa])/g)];
      return tokens.length && tokens.every(([, token]) => Number(values[token!] ?? Number.NaN) === 0)
        ? ""
        : contents;
    });
    return optionalPattern.replace(/%%|%-?[YymBbd oAa]|%[\[\]]/g, token => {
      if (token === "%%") return "%";
      if (token === "%[") return "[";
      if (token === "%]") return "]";
      return values[token.slice(1)] ?? values[token.slice(2)] ?? token;
    });
  };
  const parseCall = (operation: string, currentContext = context): { name: string; args: unknown[] } => {
    const match = operation.trim().match(/^([a-z][\w-]*)(?:\(([\s\S]*)\))?$/i);
    return match
      ? { name: match[1]!.toLowerCase(), args: match[2] === undefined ? [] : parseArguments(match[2], currentContext) }
      : { name: operation.trim().toLowerCase(), args: [] };
  };
  const applyModifier = (
    value: unknown,
    operation: string,
    currentContext: FormatterContext,
    sourcePath: string
  ): unknown => {
    const { name, args } = parseCall(operation, currentContext);
    if (name === "default") return hasValue(value) ? value : args[0] ?? "";
    if (isConditionOperation(operation)) return conditionMatches(value, operation, currentContext);
    if (value === undefined || value === null || value === "") return value;
    const stringValue = stringify(value);
    const array = Array.isArray(value) ? value : undefined;
    const objectList = Boolean(
      array && (
        array.some(item => item && typeof item === "object") ||
        (array.length === 0 && /^(?:stream\.)?(?:audiotracks|subtitletracks)$/i.test(sourcePath.replace(/\s+/g, "")))
      )
    );
    const stringArray = Boolean(array && !objectList && array.every(item => typeof item === "string"));
    const kind = objectList ? "object_list" : Array.isArray(value) ? "array" : typeof value;
    const typeError = `{unknown_${kind}_modifier(${name})}`;
    const stringOnly = ["upper", "lower", "trim", "smallcaps", "subscript", "superscript", "translate", "title", "truncate", "base64", "date"];
    const numberOnly = ["bytes", "bytes10", "sbytes", "sbytes10", "bytes2", "sbytes2", "rbytes", "rbytes10", "rbytes2", "bitrate", "rbitrate", "sbitrate", "time", "star", "pstar", "hex", "octal", "binary"];
    const arrayOnly = ["join", "keep", "unique", "first", "last", "random", "sort", "rsort", "lsort", "slice"];
    const objectListOnly = ["where", "pluck", "each"];
    if (stringOnly.includes(name) && typeof value !== "string") return typeError;
    if (numberOnly.includes(name) && typeof value !== "number") return typeError;
    if (arrayOnly.includes(name) && (!array || (objectList && name !== "slice"))) return typeError;
    if (objectListOnly.includes(name) && !objectList) return typeError;
    if (["replace", "remove"].includes(name) && !(typeof value === "string" || stringArray)) return typeError;
    if (["languagecode", "languageemoji"].includes(name) && !(typeof value === "string" || stringArray)) return typeError;
    if (["length", "reverse"].includes(name) && !(typeof value === "string" || array)) return typeError;
    if (name === "string") return stringValue;
    if (name === "upper") return stringValue.toUpperCase();
    if (name === "lower") return stringValue.toLowerCase();
    if (name === "trim" && typeof value === "string") {
      if (args[0] === undefined) return value.trim();
      const chars = new Set([...stringify(args[0])]);
      const points = [...value];
      while (points.length && chars.has(points[0]!)) points.shift();
      while (points.length && chars.has(points.at(-1)!)) points.pop();
      return points.join("");
    }
    if (name === "smallcaps" && typeof value === "string") {
      const small = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ";
      return stringValue.replace(/[a-z]/gi, character => small[character.toLowerCase().charCodeAt(0) - 97] ?? character);
    }
    if ((name === "subscript" || name === "superscript") && typeof value === "string") {
      const digits = name === "subscript" ? "₀₁₂₃₄₅₆₇₈₉" : "⁰¹²³⁴⁵⁶⁷⁸⁹";
      return stringValue.replace(/[0-9]/g, digit => digits[Number(digit)]!);
    }
    if (name === "translate" && typeof value === "string") {
      const from = stringify(args[0] ?? "");
      const to = stringify(args[1] ?? "");
      return [...stringValue].map(character => {
        const index = [...from].indexOf(character);
        return index < 0 ? character : [...to][index] ?? character;
      }).join("");
    }
    if (name === "title" && typeof value === "string") return stringValue.replace(/\b\w/g, character => character.toUpperCase());
    if (name === "replace") {
      let find = stringify(args[0] ?? "");
      if (find.includes("{")) find = renderTemplate(find, currentContext);
      const replacement = stringify(args[1] ?? "");
      return array && !objectList
        ? array.map(item => stringify(item).toLowerCase() === find.toLowerCase() ? replacement : item)
        : typeof value === "string" ? stringValue.split(find).join(replacement) : undefined;
    }
    if (name === "remove") {
      const values = args.map(stringify);
      return array && !objectList
        ? array.filter(item => !values.some(remove => stringify(item).toLowerCase() === remove.toLowerCase()))
        : typeof value === "string" ? values.reduce((result, remove) => result.split(remove).join(""), stringValue) : undefined;
    }
    if (name === "truncate" && typeof value === "string") {
      const length = Math.max(0, Number(args[0]) || 0);
      return stringValue.length > length ? `${stringValue.slice(0, length)}…` : stringValue;
    }
    if (name === "length") return array ? array.length : stringValue.length;
    if (name === "reverse") return array ? [...array].reverse() : [...stringValue].reverse().join("");
    if (name === "base64" && typeof value === "string") {
      const bytes = new TextEncoder().encode(stringValue);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return btoa(binary);
    }
    if (name === "languagecode") return mapValue(value, languageCode);
    if (name === "languageemoji") return mapValue(value, languageEmoji);
    if (name === "join" && array && !objectList) return array.map(stringify).join(stringify(args[0] ?? ", "));
    if (name === "keep" && array && !objectList) {
      const included = args.flatMap(item => Array.isArray(item) ? item : [item]).map(item => stringify(item).toLowerCase());
      return array.filter(item => included.includes(stringify(item).toLowerCase()));
    }
    if (name === "unique" && array && !objectList) {
      const seen = new Set<string>();
      return array.filter(item => {
        const key = stringify(item).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (name === "slice" && array) return array.slice(Number(args[0]) || 0, args[1] === undefined ? undefined : Number(args[1]));
    if (name === "first" && array && !objectList) return array[0];
    if (name === "last" && array && !objectList) return array.at(-1);
    if (name === "random" && array && !objectList) return array[Math.floor(Math.random() * array.length)];
    if ((name === "sort" || name === "rsort" || name === "lsort") && array && !objectList) {
      const sorted = [...array].sort((left, right) => {
        if (name !== "lsort" && typeof left === "number" && typeof right === "number") return left - right;
        return stringify(left).localeCompare(stringify(right), undefined, {
          numeric: name !== "lsort",
          sensitivity: name === "lsort" ? "variant" : "base"
        });
      });
      return name === "rsort" ? sorted.reverse() : sorted;
    }
    if (name === "bytes" || name === "bytes10" || name === "sbytes" || name === "sbytes10" || name === "bytes2" || name === "sbytes2" || name === "rbytes" || name === "rbytes10" || name === "rbytes2") {
      const number = Number(value);
      if (!Number.isFinite(number)) return "";
      const base = name.endsWith("2") ? 1024 : 1000;
      return formatBytes(number, base, name.startsWith("s"), name.startsWith("r"));
    }
    if (["bitrate", "rbitrate", "sbitrate"].includes(name)) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "";
      const divisor = Math.abs(number) >= 1_000_000 ? 1_000_000 : 1_000;
      const unit = divisor === 1_000_000 ? "Mbps" : "Kbps";
      const amount = number / divisor;
      return `${name === "rbitrate" ? Math.round(amount) : Number(amount.toFixed(name === "sbitrate" ? 1 : 2))} ${unit}`;
    }
    if (name === "time") {
      const number = Number(value);
      if (!Number.isFinite(number)) return "";
      if (args[0] !== undefined) return durationPattern(number, stringify(args[0]));
      const seconds = Math.floor(number / 1000);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor(seconds % 3600 / 60);
      const remainder = seconds % 60;
      return hours
        ? `${hours}h:${String(minutes).padStart(2, "0")}m:${String(remainder).padStart(2, "0")}s`
        : `${minutes}m:${String(remainder).padStart(2, "0")}s`;
    }
    if (name === "date") return datePattern(value, stringify(args[0] ?? "%Y-%m-%d"));
    if (["star", "pstar"].includes(name)) {
      const score = Math.max(0, Math.min(100, Number(value)));
      if (!Number.isFinite(score)) return "";
      const count = Math.round(score / 20);
      return name === "pstar" ? "★".repeat(count) + "☆".repeat(5 - count) : "★".repeat(count);
    }
    if (["hex", "octal", "binary"].includes(name)) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "";
      return Math.trunc(number).toString(name === "hex" ? 16 : name === "octal" ? 8 : 2);
    }
    if (["where", "pluck", "each"].includes(name) && array && objectList) {
      if (name === "where") {
        return array.filter(item => args.every(condition => matchesObjectCondition(item, stringify(condition), currentContext)));
      }
      if (name === "pluck") {
        const values = array.flatMap(item => {
          const value = getProperty(item, stringify(args[0] ?? ""));
          return value == null ? [] : Array.isArray(value) ? value : [value];
        });
        return [...new Map(values.map(item => [stringify(item).toLowerCase(), item])).values()];
      }
      if (name === "each") {
        if ((currentContext.__eachDepth as number | undefined) ?? 0) return "{unknown_object_list_modifier(each)}";
        const itemTemplate = stringify(args[0] ?? "");
        const output: string[] = [];
        for (const item of array.slice(0, Math.max(0, 256 - eachCount))) {
          eachCount++;
          const itemContext = { ...currentContext, track: item, __eachDepth: 1 };
          const rendered = renderTemplate(itemTemplate, itemContext);
          if (rendered.trim()) output.push(rendered);
        }
        return output;
      }
    }
    if (name === "exists") return hasValue(value);
    return typeError;
  };

  const matchesObjectCondition = (
    item: unknown,
    rawCondition: string,
    currentContext: FormatterContext
  ): boolean => {
    const condition = rawCondition.replace(/\{([^{}]+)\}/g, (_match, path: string) => {
      const value = getPath(path, currentContext);
      return Array.isArray(value) ? value.map(stringify).join("|") : stringify(value);
    });
    const negated = condition.startsWith("!");
    const expression = negated ? condition.slice(1) : condition;
    const match = expression.match(/^([^=~]+)([=~])([\s\S]*)$/);
    const actual = getProperty(item, match?.[1] ?? expression);
    let matched = actual === true || (actual !== false && hasValue(actual));
    if (match) {
      const expected = match[3]!.split("|").map(value => value.toLowerCase());
      const actualValues = (Array.isArray(actual) ? actual : [actual]).map(value => stringify(value).toLowerCase());
      matched = match[2] === "="
        ? actualValues.some(value => expected.includes(value))
        : actualValues.some(value => expected.some(part => value.includes(part)));
    }
    return negated ? !matched : matched;
  };

  const isConditionOperation = (operation: string): boolean =>
    /^(?:is?true|is?false|exists|in\(|>=|<=|>|<|=|~|\$|\^)/i.test(operation.trim());
  const isFieldOperation = (operation: string): boolean =>
    /^[a-z][\w-]*\.[\w.-]+$/i.test(operation.trim());
  const conditionMatches = (
    value: unknown,
    operation: string,
    currentContext: FormatterContext
  ): boolean => {
    if (!hasValue(value)) return false;
    const normalized = operation.trim();
    const call = parseCall(normalized, currentContext);
    if (["true", "istrue"].includes(call.name)) return value === true || value === 1 || stringify(value).toLowerCase() === "true";
    if (["false", "isfalse"].includes(call.name)) return value === false || value === 0 || stringify(value).toLowerCase() === "false";
    if (call.name === "exists") return hasValue(value);
    if (call.name === "in") {
      const expected = call.args.flatMap(item => Array.isArray(item) ? item : [item]).map(item => stringify(item).toLowerCase());
      const actual = (Array.isArray(value) ? value : [value]).map(item => stringify(item).toLowerCase());
      return actual.some(item => expected.includes(item));
    }
    const match = normalized.match(/^(>=|<=|>|<|=|~|\$|\^)([\s\S]*)$/);
    if (!match) return Boolean(value);
    const expected = match[2]!.trim();
    const values = Array.isArray(value) ? value : [value];
    if ([">", ">=", "<", "<=", "="].includes(match[1]!)) {
      return values.some(item => {
        const left = Number(item);
        const right = Number(expected);
        if (Number.isFinite(left) && Number.isFinite(right)) {
          if (match[1] === ">") return left > right;
          if (match[1] === ">=") return left >= right;
          if (match[1] === "<") return left < right;
          if (match[1] === "<=") return left <= right;
          if (match[1] === "=") return left === right;
        }
        return match[1] === "=" && stringify(item).toLowerCase() === expected.toLowerCase();
      });
    }
    const expectedValues = parseArgument(expected, currentContext);
    const expectedList = (Array.isArray(expectedValues) ? expectedValues : [expectedValues]).map(item => stringify(item).toLowerCase());
    if (Array.isArray(value) && match[1] === "$") {
      return expectedList.includes(stringify(value[0]).toLowerCase());
    }
    if (Array.isArray(value) && match[1] === "^") {
      return expectedList.includes(stringify(value.at(-1)).toLowerCase());
    }
    return values.some(item => {
      const text = stringify(item).toLowerCase();
      if (match[1] === "~") return expectedList.some(part => text.includes(part));
      if (Array.isArray(value) && match[1] === "$") return text === expectedList[0];
      if (Array.isArray(value) && match[1] === "^") return text === expectedList[0];
      return match[1] === "$" ? expectedList.some(part => text.startsWith(part))
        : expectedList.some(part => text.endsWith(part));
    });
  };
  const findBranch = (expression: string): { condition: string; branches: string[] } | undefined => {
    if (!expression.endsWith("]")) return undefined;
    let quote = "";
    let escaped = false;
    let braces = 0;
    let parentheses = 0;
    let branchStart = -1;
    for (let index = 0; index < expression.length; index++) {
      const character = expression[index]!;
      if (character === "{") { braces++; continue; }
      if (character === "}" && braces > 0) { braces--; continue; }
      if (braces > 0) continue;
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "'" || character === '"') { quote = character; continue; }
      if (character === "(") parentheses++;
      else if (character === ")" && parentheses > 0) parentheses--;
      else if (character === "[" && parentheses === 0) branchStart = index;
    }
    if (branchStart < 0) return undefined;
    return {
      condition: expression.slice(0, branchStart),
      branches: splitTopLevel(expression.slice(branchStart + 1, -1), "||").map(unquote)
    };
  };
  const evaluateExpression = (expression: string, currentContext: FormatterContext): unknown => {
    const branch = findBranch(expression);
    const parts = splitTopLevel(branch?.condition ?? expression, "::").map(part => part.trim());
    const base = parts.shift() ?? "";
    let value: unknown;
    if (/^(['"]).*\1$/s.test(base)) value = unquote(base);
    else value = getPath(base, currentContext);
    let sourcePath = base;
    let present = hasValue(value);
    if (branch) {
      let result: boolean | undefined;
      let connector: "and" | "or" | "xor" | undefined;
      for (const operation of parts) {
        const normalized = operation.toLowerCase();
        if (["and", "or", "xor"].includes(normalized)) {
          connector = normalized as "and" | "or" | "xor";
          continue;
        }
        if (connector && isFieldOperation(operation)) {
          value = getPath(operation, currentContext);
          present = hasValue(value);
        }
        if (isConditionOperation(operation)) {
          const next = conditionMatches(value, operation, currentContext);
          if (result === undefined) result = next;
          else if (connector === "and") result = result && next;
          else if (connector === "xor") result = result !== next;
          else result = result || next;
          connector = undefined;
        } else if (!connector) {
          value = applyModifier(value, operation, currentContext, sourcePath);
          if (/^(?:pluck|each)\s*\(/i.test(operation)) sourcePath = "";
          if (normalized.startsWith("default(") && hasValue(value)) present = true;
        }
      }
      const selected = result ?? (typeof value === "boolean" ? value : hasValue(value));
      const selectedTemplate = !present
        ? branch.branches[2] ?? ""
        : branch.branches[selected ? 0 : 1] ?? "";
      return renderTemplate(selectedTemplate, currentContext);
    }
    for (const operation of parts) {
      value = applyModifier(value, operation, currentContext, sourcePath);
      if (/^(?:pluck|each)\s*\(/i.test(operation)) sourcePath = "";
      if (typeof value === "string" && /^\{unknown_[^}]+\}$/.test(value)) break;
    }
    return value;
  };
  const findClosingBrace = (source: string, start: number): number => {
    let depth = 1;
    for (let index = start + 1; index < source.length; index++) {
      if (source[index] === "{") depth++;
      else if (source[index] === "}" && --depth === 0) return index;
    }
    return -1;
  };
  const findOptionalEnd = (source: string, start: number): number => {
    let depth = 1;
    for (let index = start + 2; index < source.length - 1; index++) {
      if (source.startsWith("{?", index)) { depth++; index++; }
      else if (source.startsWith("?}", index)) {
        depth--;
        if (depth === 0) return index;
        index++;
      }
    }
    return -1;
  };
  const collectFields = (source: string): string[] => {
    const fields: string[] = [];
    for (let index = 0; index < source.length; index++) {
      if (source.startsWith("{?", index)) {
        const end = findOptionalEnd(source, index);
        if (end >= 0) {
          index = end + 1;
          continue;
        }
      }
      if (source[index] !== "{") continue;
      const end = findClosingBrace(source, index);
      if (end < 0) continue;
      const expression = source.slice(index + 1, end);
      const base = splitTopLevel(expression, "::")[0]?.trim() ?? "";
      if (/^[a-z][\w-]*\.[\w.-]+$/i.test(base)) fields.push(base);
      fields.push(...collectFields(expression));
      index = end;
    }
    return fields;
  };
  let eachCount = 0;
  const renderTemplate = (
    source: string,
    currentContext: FormatterContext,
    eachDepth = 0,
    depth = 0
  ): string => {
    if (depth > 12) return source;
    let output = "";
    for (let index = 0; index < source.length; index++) {
      if (source.startsWith("{?", index)) {
        const end = findOptionalEnd(source, index);
        if (end >= 0) {
          const body = source.slice(index + 2, end);
          const fields = collectFields(body);
          if (fields.every(field => hasValue(getPath(field, currentContext)))) {
            output += renderTemplate(body, currentContext, eachDepth, depth + 1);
          }
          index = end + 1;
          continue;
        }
      }
      if (source[index] !== "{") {
        output += source[index];
        continue;
      }
      const end = findClosingBrace(source, index);
      if (end < 0) {
        output += source.slice(index);
        break;
      }
      const expression = source.slice(index + 1, end);
      if (expression.toLowerCase() === "tools.newline") output += "\n";
      else if (expression.toLowerCase() === "tools.removeline") output += REMOVE_LINE;
      else {
        try {
          const value = evaluateExpression(expression, currentContext);
          output += Array.isArray(value) ? value.map(stringify).join(", ") : stringify(value);
        } catch {
          output += `{${expression}}`;
        }
      }
      index = end;
    }
    if (!eachDepth) {
      output = output.split(/\r?\n/)
        .filter(line => !line.includes(REMOVE_LINE))
        .join("\n");
    }
    return output;
  };

  return renderTemplate(template, context);
}