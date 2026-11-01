const sourceFile = /\.(?:[cm]?[jt]sx?|py)$/;
const looksLikeFile = (part: string) => part.includes("/") || sourceFile.test(part);

/**
 * A test name as a producer may write it: a title path, the file first as runners print it
 * ("test/a.test.ts > suite > title"), a test id ("test/a.test.ts::suite > title"), or a file
 * alone, which names every test in it (an empty title).
 */
export function splitTestName(name: string): {
  readonly file: string | null;
  readonly title: string;
} {
  const id = name.indexOf("::");
  if (id > 0) return { file: name.slice(0, id), title: name.slice(id + 2) };
  const parts = name.split(" > ");
  const [first, ...rest] = parts;
  // A file alone names every test in it; a title alone may hold a slash, so only an extension
  // makes a bare name a file.
  if (first !== undefined && rest.length === 0 && sourceFile.test(first)) {
    return { file: first, title: "" };
  }
  return first !== undefined && rest.length > 0 && looksLikeFile(first)
    ? { file: first, title: rest.join(" > ") }
    : { file: null, title: name };
}

/** A name selects a test when its parts are a contiguous run of the test's suite path and title. */
export function titleSelects(title: string, name: string): boolean {
  if (name.trim().length === 0) return false;
  const parts = title.split(" > ");
  const wanted = name.split(" > ");
  for (let start = 0; start + wanted.length <= parts.length; start += 1) {
    if (wanted.every((part, at) => parts[start + at] === part)) return true;
  }
  return false;
}
