import {
  StateEffect,
  StateField,
  type EditorState,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  runScopeHandlers,
  type DecorationSet,
} from "@codemirror/view";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { readSensitiveAsset, subscribeSensitiveAssetsInvalidated } from "../lib/secureAssets";
import { i18n } from "../lib/i18n";

// Decorations never serialize rendered HTML back into the note. Unknown syntax,
// whitespace, reference links and asset URLs stay in the underlying document.
const focused = StateEffect.define<boolean>();
type Tree = ReturnType<typeof markdownLanguage.parser.parse>;
type Node = Tree["topNode"];

function cellText(text: string) {
  return text.replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|");
}

/** Toolbar actions use the selection in a rendered cell, not the previous
 * selection in the surrounding Markdown document. */
export function syncTableSelection(view: EditorView) {
  const input = document.activeElement;
  if (
    !(input instanceof HTMLElement) ||
    !input.classList.contains("md-live-cell") ||
    !view.dom.contains(input)
  )
    return;
  const selection = document.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !input.contains(selection.anchorNode) ||
    !input.contains(selection.focusNode)
  )
    return;
  const offset = (node: globalThis.Node, at: number) => {
    const range = document.createRange();
    range.selectNodeContents(input);
    range.setEnd(node, at);
    return Math.min(
      Number(input.dataset.to),
      Number(input.dataset.from) + cellText(range.toString()).length,
    );
  };
  view.dispatch({
    selection: {
      anchor: offset(selection.anchorNode, selection.anchorOffset),
      head: offset(selection.focusNode, selection.focusOffset),
    },
  });
}

function editAt(view: EditorView, position: number) {
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  view.focus();
}

class TaskWidget extends WidgetType {
  readonly checked: boolean;
  readonly from: number;
  readonly disabled: boolean;
  constructor(checked: boolean, from: number, disabled: boolean) {
    super();
    this.checked = checked;
    this.from = from;
    this.disabled = disabled;
  }
  eq(other: TaskWidget) {
    return (
      this.checked === other.checked &&
      this.from === other.from &&
      this.disabled === other.disabled
    );
  }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "md-live-task";
    input.checked = this.checked;
    input.disabled =
      view.state.readOnly || !view.state.facet(EditorView.editable);
    input.setAttribute("aria-label", i18n.t("notes.liveTask"));
    input.addEventListener("mousedown", (e) => e.preventDefault());
    input.addEventListener("change", () => {
      if (view.state.readOnly || !view.state.facet(EditorView.editable)) return;
      view.dispatch({
        changes: {
          from: this.from + 1,
          to: this.from + 2,
          insert: input.checked ? "x" : " ",
        },
        userEvent: "input",
      });
    });
    return input;
  }
  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-live-bullet";
    el.textContent = "•";
    return el;
  }
}

class RuleWidget extends WidgetType {
  readonly from: number;
  constructor(from: number) {
    super();
    this.from = from;
  }
  eq(other: RuleWidget) {
    return this.from === other.from;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("hr");
    el.className = "md-live-rule";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      editAt(view, this.from);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// Only vault assets and raster data images are loaded. A Markdown image must not
// issue requests to arbitrary remote hosts while editing a private note.
class ImageWidget extends WidgetType {
  readonly source: string;
  readonly alt: string;
  readonly from: number;
  constructor(source: string, alt: string, from: number) {
    super();
    this.source = source;
    this.alt = alt;
    this.from = from;
  }
  eq(other: ImageWidget) {
    return (
      this.source === other.source &&
      this.alt === other.alt &&
      this.from === other.from
    );
  }
  toDOM(view: EditorView) {
    const host = document.createElement("span");
    host.className = "md-live-image";
    host.textContent = this.alt || i18n.t("notes.liveImage");
    host.title = i18n.t("notes.liveEditImage");
    host.addEventListener("mousedown", (e) => {
      e.preventDefault();
      editAt(view, this.from + 2);
    });
    const show = (url: string) => {
      if (!/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(url)) return;
      const image = document.createElement("img");
      image.alt = this.alt;
      image.src = url;
      image.addEventListener("load", () => view.requestMeasure());
      host.replaceChildren(image);
    };
    if (/^kmasset:\/\/[a-f0-9]{64}$/i.test(this.source)) {
      let cancelled = false;
      const unsubscribe = subscribeSensitiveAssetsInvalidated(() => {
        cancelled = true;
        host.replaceChildren();
      });
      readSensitiveAsset(this.source.slice(10))
        .then((url) => {
          if (!cancelled) show(url);
        })
        .catch(() => {});
      // The widget owns this cancellation hook; there is no decrypted global cache.
      (host as HTMLElement & { cancel?: () => void }).cancel = () => {
        cancelled = true;
        unsubscribe();
      };
    } else show(this.source);
    return host;
  }
  destroy(dom: HTMLElement) {
    (dom as HTMLElement & { cancel?: () => void }).cancel?.();
  }
  ignoreEvent() {
    return true;
  }
}

// Lezer omits empty TableCell nodes. Split on its delimiter tokens instead, so
// clearing a cell keeps its position, native focus and the table's column count.
function tableRows(node: Node, state: EditorState) {
  const rows: { header: boolean; cells: { from: number; to: number }[] }[] = [];
  for (let row = node.firstChild; row; row = row.nextSibling) {
    if (row.name !== "TableHeader" && row.name !== "TableRow") continue;
    const spans: { from: number; to: number }[] = [];
    let start = row.from;
    for (let child = row.firstChild; child; child = child.nextSibling) {
      if (child.name !== "TableDelimiter") continue;
      if (child.from > start || start !== row.from)
        spans.push({ from: start, to: child.from });
      start = child.to;
    }
    if (start < row.to) spans.push({ from: start, to: row.to });
    const cells = spans.map(({ from, to }) => {
      const text = state.sliceDoc(from, to);
      if (!text.trim()) {
        const at = Math.min(from + 1, to);
        return { from: at, to: at };
      }
      return {
        from: from + text.length - text.trimStart().length,
        to: to - text.length + text.trimEnd().length,
      };
    });
    rows.push({ header: row.name === "TableHeader", cells });
  }
  return rows;
}

function paintCell(input: HTMLElement, source: string) {
  input.replaceChildren();
  const root = markdownLanguage.parser.parse(source).topNode.firstChild;
  if (!root || root.name !== "Paragraph") {
    input.textContent = source;
    return;
  }
  const tags: Record<string, string> = {
    StrongEmphasis: "strong",
    Emphasis: "em",
    Strikethrough: "s",
    InlineCode: "code",
    Link: "span",
  };
  const append = (parent: HTMLElement, node: Node) => {
    if (
      [
        "EmphasisMark",
        "StrikethroughMark",
        "CodeMark",
        "LinkMark",
        "LinkTitle",
        "LinkLabel",
      ].includes(node.name) ||
      (node.name === "URL" && node.parent?.name === "Link")
    )
      return;
    if (!node.firstChild) {
      parent.append(
        document.createTextNode(
          source.slice(node.from + (node.name === "Escape" ? 1 : 0), node.to),
        ),
      );
      return;
    }
    const el = tags[node.name]
      ? document.createElement(tags[node.name])
      : parent;
    if (node.name === "Link") el.className = "md-live-link";
    let pos = node.from;
    for (let child: Node | null = node.firstChild; child; child = child.nextSibling) {
      if (child.from > pos)
        el.append(document.createTextNode(source.slice(pos, child.from)));
      append(el, child);
      pos = child.to;
    }
    if (pos < node.to)
      el.append(document.createTextNode(source.slice(pos, node.to)));
    if (el !== parent) parent.append(el);
  };
  append(input, root);
}

class TableWidget extends WidgetType {
  readonly source: string;
  readonly from: number;
  readonly node: Node;
  readonly disabled: boolean;
  constructor(source: string, from: number, node: Node, disabled: boolean) {
    super();
    this.source = source;
    this.from = from;
    this.node = node;
    this.disabled = disabled;
  }
  eq(other: TableWidget) {
    return (
      this.source === other.source &&
      this.from === other.from &&
      this.disabled === other.disabled
    );
  }
  toDOM(view: EditorView) {
    const host = document.createElement("div");
    host.className = "md-live-table";
    host.dataset.end = String(this.node.to);
    const table = document.createElement("table");
    host.append(table);
    const rows = tableRows(this.node, view.state);
    host.dataset.shape = rows.map((row) => row.cells.length).join(",");
    for (const row of rows) {
      const tr = document.createElement("tr");
      table.append(tr);
      for (const cell of row.cells) {
        const td = document.createElement(row.header ? "th" : "td");
        const input = document.createElement("span");
        input.className = "md-live-cell";
        input.contentEditable =
          view.state.readOnly || !view.state.facet(EditorView.editable)
            ? "false"
            : "plaintext-only";
        input.setAttribute("role", "textbox");
        input.setAttribute("aria-label", i18n.t("notes.liveEditTable"));
        input.dataset.from = String(cell.from);
        input.dataset.to = String(cell.to);
        paintCell(input, view.state.sliceDoc(cell.from, cell.to));
        input.addEventListener("focus", () => {
          input.textContent = view.state.sliceDoc(
            Number(input.dataset.from),
            Number(input.dataset.to),
          );
        });
        input.addEventListener("blur", () => {
          if (input.isConnected)
            paintCell(
              input,
              view.state.sliceDoc(
                Number(input.dataset.from),
                Number(input.dataset.to),
              ),
            );
        });
        const commit = () => {
          if (
            !input.isConnected ||
            view.state.readOnly ||
            !view.state.facet(EditorView.editable)
          )
            return;
          const from = Number(input.dataset.from),
            to = Number(input.dataset.to);
          // A cell cannot introduce a new Markdown row or column accidentally.
          const insert = cellText(input.textContent || "");
          if (view.state.sliceDoc(from, to) !== insert)
            view.dispatch({
              changes: { from, to, insert },
              userEvent: "input.type",
            });
        };
        let composing = false;
        input.addEventListener("compositionstart", () => {
          composing = true;
        });
        input.addEventListener("compositionend", () => {
          composing = false;
          commit();
        });
        input.addEventListener("input", () => {
          if (!composing) commit();
        });
        input.addEventListener("keydown", (e) => {
          if (e.isComposing || composing) return;
          if (
            (e.ctrlKey || e.metaKey) &&
            ["z", "y", "s", "b", "i"].includes(e.key.toLowerCase())
          ) {
            e.preventDefault();
            if (["b", "i"].includes(e.key.toLowerCase()))
              syncTableSelection(view);
            runScopeHandlers(view, e, "editor");
          } else if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            commit();
            // Return to a paragraph after the table without requiring a mode switch.
            editAt(
              view,
              Math.min(view.state.doc.length, Number(host.dataset.end) + 1),
            );
          }
        });
        td.append(input);
        tr.append(td);
      }
    }
    return host;
  }
  updateDOM(host: HTMLElement, view: EditorView) {
    host.dataset.end = String(this.node.to);
    const rows = tableRows(this.node, view.state);
    if (host.dataset.shape !== rows.map((row) => row.cells.length).join(","))
      return false;
    const cells = rows.flatMap((row) => row.cells);
    const inputs = host.querySelectorAll<HTMLElement>(".md-live-cell");
    if (inputs.length !== cells.length) return false;
    inputs.forEach((input, index) => {
      const cell = cells[index];
      input.dataset.from = String(cell.from);
      input.dataset.to = String(cell.to);
      input.contentEditable =
        view.state.readOnly || !view.state.facet(EditorView.editable)
          ? "false"
          : "plaintext-only";
      // Preserve native selection and IME inside a cell across document updates.
      const text = view.state.sliceDoc(cell.from, cell.to);
      if (document.activeElement !== input) {
        paintCell(input, text);
        return;
      }
      const current = cellText(input.textContent || "");
      if (current !== text) {
        input.textContent = text;
        if (document.activeElement === input) {
          const range = document.createRange();
          range.selectNodeContents(input);
          range.collapse(false);
          const selection = document.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
    });
    return true;
  }
  ignoreEvent() {
    return true;
  }
}

function decorate(
  state: EditorState,
  tree: Tree,
  hasFocus: boolean,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const disabled = state.readOnly || !state.facet(EditorView.editable);
  const active = (from: number, to: number) =>
    hasFocus &&
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const lineActive = (from: number, to: number) =>
    active(state.doc.lineAt(from).from, state.doc.lineAt(to).to);
  const hide = (from: number, to: number) => {
    if (to > from) ranges.push(Decoration.replace({}).range(from, to));
  };
  const mark = (from: number, to: number, className: string) => {
    if (to > from)
      ranges.push(Decoration.mark({ class: className }).range(from, to));
  };
  const line = (pos: number, className: string) =>
    ranges.push(
      Decoration.line({ class: className }).range(state.doc.lineAt(pos).from),
    );
  const visit = (node: Node) => {
    const { name, from, to } = node;
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
    if (heading) {
      line(from, `md-live-heading md-live-h${heading[1]}`);
      if (!lineActive(from, to)) {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === "HeaderMark") {
            // Include the separator space after ATX prefixes, not the text itself.
            hide(
              child.from,
              Math.min(
                to,
                child.to +
                  (state.sliceDoc(child.to, child.to + 1) === " " ? 1 : 0),
              ),
            );
          }
        }
      }
    }
    if (name === "FencedCode" || name === "CodeBlock") {
      for (
        let n = state.doc.lineAt(from).number;
        n <= state.doc.lineAt(to).number;
        n++
      )
        line(state.doc.line(n).from, "md-live-code-line");
      if (!active(from, to) && name === "FencedCode") {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === "CodeMark" || child.name === "CodeInfo")
            hide(child.from, child.to);
          if (child.name === "CodeMark") line(child.from, "md-live-fence-line");
        }
      }
      return;
    }
    if (name === "Table" && !lineActive(from, to)) {
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(
            state.sliceDoc(from, to),
            from,
            node,
            disabled,
          ),
          block: true,
        }).range(from, to),
      );
      return;
    }
    if (name === "Image" && !active(from, to)) {
      const url = node.getChild("URL");
      if (url) {
        const text = state.sliceDoc(from, to);
        ranges.push(
          Decoration.replace({
            widget: new ImageWidget(
              state.sliceDoc(url.from, url.to),
              text.slice(2, text.indexOf("]")),
              from,
            ),
          }).range(from, to),
        );
        return;
      }
    }
    if (name === "HorizontalRule" && !lineActive(from, to)) {
      ranges.push(
        Decoration.replace({ widget: new RuleWidget(from) }).range(from, to),
      );
      return;
    }
    if (name === "Blockquote") {
      for (
        let n = state.doc.lineAt(from).number;
        n <= state.doc.lineAt(to).number;
        n++
      )
        line(state.doc.line(n).from, "md-live-quote");
    }
    if (name === "QuoteMark" && !lineActive(from, to)) hide(from, to);
    if (
      name === "ListMark" &&
      !lineActive(from, to) &&
      /^[-+*]$/.test(state.sliceDoc(from, to))
    ) {
      if (/^\s+\[[ xX]\]/.test(state.sliceDoc(to, state.doc.lineAt(to).to)))
        hide(from, to + 1);
      else
        ranges.push(
          Decoration.replace({ widget: new BulletWidget() }).range(from, to),
        );
    }
    if (name === "TaskMarker" && !active(from, to)) {
      ranges.push(
        Decoration.replace({
          widget: new TaskWidget(
            /x/i.test(state.sliceDoc(from, to)),
            from,
            disabled,
          ),
        }).range(from, to),
      );
    }
    const inlineClass: Record<string, string> = {
      StrongEmphasis: "md-live-strong",
      Emphasis: "md-live-em",
      Strikethrough: "md-live-strike",
      InlineCode: "md-live-code",
      Link: "md-live-link",
    };
    if (inlineClass[name]) {
      mark(from, to, inlineClass[name]);
      if (!active(from, to)) {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (
            [
              "EmphasisMark",
              "StrikethroughMark",
              "CodeMark",
              "LinkMark",
              "URL",
              "LinkTitle",
              "LinkLabel",
            ].includes(child.name)
          )
            hide(child.from, child.to);
        }
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling)
      visit(child);
  };
  visit(tree.topNode);
  return Decoration.set(ranges, true);
}

export function markdownLivePreview() {
  const field = StateField.define<{
    tree: Tree;
    hasFocus: boolean;
    decorations: DecorationSet;
  }>({
    create(state) {
      const tree = markdownLanguage.parser.parse(state.doc.toString());
      return {
        tree,
        hasFocus: false,
        decorations: decorate(state, tree, false),
      };
    },
    update(value, tr) {
      const focusChange = tr.effects.find((e) => e.is(focused));
      if (!tr.docChanged && !tr.selection && !focusChange && !tr.reconfigured)
        return value;
      const tree = tr.docChanged
        ? markdownLanguage.parser.parse(tr.newDoc.toString())
        : value.tree;
      const hasFocus = focusChange
        ? (focusChange.value as boolean)
        : value.hasFocus;
      return {
        tree,
        hasFocus,
        decorations: decorate(tr.state, tree, hasFocus),
      };
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  });
  return [
    field,
    EditorView.updateListener.of((update) => {
      if (!update.focusChanged) return;
      queueMicrotask(() => {
        if (update.view.state.field(field, false))
          update.view.dispatch({ effects: focused.of(update.view.hasFocus) });
      });
    }),
  ];
}
