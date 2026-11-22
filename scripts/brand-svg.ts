/**
 * SVG policy for the brand masters: well-formed XML (a real parser, any
 * warning or error is a problem), an svg root with a viewBox and no width or
 * height, and no filter anywhere.
 */
import { DOMParser, ParseError } from "@xmldom/xmldom";

/** Every element under `node`, depth first. */
function elements(node: Element): Element[] {
  const out: Element[] = [node];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) out.push(...elements(c as Element));
  }
  return out;
}

/** Problems with one SVG document; empty when it satisfies the policy. */
export function svgProblems(svg: string): string[] {
  const problems: string[] = [];
  const parser = new DOMParser({
    onError: (level: string, message: string) => {
      problems.push(
        `not well-formed XML (${level}): ${message.split("\n")[0]}`,
      );
    },
  });
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    doc = parser.parseFromString(svg, "image/svg+xml");
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return [`not well-formed XML (fatal): ${e.message.split("\n")[0]}`];
  }
  const root = doc.documentElement;
  if (problems.length > 0 || !root) {
    return problems.length > 0 ? problems : ["no root element"];
  }
  if (root.nodeName !== "svg") return ["root element is not svg"];
  if (!root.hasAttribute("viewBox")) problems.push("no viewBox");
  if (root.hasAttribute("width") || root.hasAttribute("height")) {
    problems.push("width or height on the root (viewBox only)");
  }
  for (const el of elements(root as unknown as Element)) {
    const style = el.getAttribute("style") ?? "";
    if (
      /^fe[A-Z]|^filter$/.test(el.nodeName) ||
      el.hasAttribute("filter") ||
      /filter/i.test(style)
    ) {
      problems.push(`uses a filter (<${el.nodeName}>)`);
    }
  }
  return problems;
}
