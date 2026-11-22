import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
import ar from "../../i18n/locales/ar/translation.json";
import he from "../../i18n/locales/he/translation.json";
import { createRequire } from "node:module";
const {
  describe,
  it,
  mock,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
  mock: { module: (name: string, factory: () => unknown) => void };
} = createRequire(import.meta.url)("bun:test");

const stored: Record<string, string> = {};
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: (key: string) => stored[key],
    updateSetting: async () => {},
    isUpdating: () => false,
  }),
}));
interface Row {
  title: string;
  description: string;
  selectedValue: string | null;
  gridProps: Record<string, unknown> | null;
}
const rows: Row[] = [];
mock.module("@/components/ui/SettingContainer", () => ({
  SettingContainer: ({
    title,
    description,
    children,
  }: {
    title: string;
    description: string;
    children: React.ReactElement;
  }) => {
    const props = children.props as Record<string, unknown>;
    rows.push({
      title,
      description,
      selectedValue: (props.selectedValue ?? props.value ?? null) as
        | string
        | null,
      gridProps: "value" in props ? props : null,
    });
    return null;
  },
}));
const { ShowOverlay } = await import("./ShowOverlay");
const { PositionGrid, CELLS, moveCell, handleCellKey } = await import(
  "./PositionGrid"
);
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

type Locale = typeof en;
type Cell = (typeof CELLS)[number];
const localeDirs = readdirSync(new URL("../../i18n/locales/", import.meta.url));
const locales: Record<string, Locale> = {};
for (const dir of localeDirs) {
  locales[dir] = (
    await import(`../../i18n/locales/${dir}/translation.json`)
  ).default;
}

function renderRows(style: string, position?: string): Row[] {
  stored.overlay_style = style;
  if (position === undefined) delete stored.overlay_position;
  else stored.overlay_position = position;
  rows.length = 0;
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ShowOverlay />
    </I18nextProvider>,
  );
  return [...rows];
}

function positionRow(style: string, position?: string): Row {
  const row = renderRows(style, position).find(
    (candidate) => candidate.title === "Floating window position",
  );
  assert.ok(row, "position row");
  return row;
}

const cellLabelsOf =
  (locale: Locale) =>
  (cell: Cell): string =>
    locale.floating.position.cells[cell];

function decode(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function gridMarkup(locale: Locale, value: Cell): string {
  return renderToStaticMarkup(
    <PositionGrid
      value={value}
      onChange={() => {}}
      label={locale.settings.advanced.overlay.position.title}
      cellLabel={cellLabelsOf(locale)}
    />,
  );
}

function radios(html: string) {
  return [...html.matchAll(/<button\b[^>]*role="radio"[^>]*>/g)].map(
    (match) => {
      const attr = (name: string) =>
        new RegExp(`\\s${name}="([^"]*)"`).exec(match[0])?.[1];
      return {
        label: decode(attr("aria-label") ?? ""),
        title: decode(attr("title") ?? ""),
        checked: attr("aria-checked"),
        tabindex: attr("tabindex"),
      };
    },
  );
}

const EN_LABELS = [
  "Top left",
  "Top centre",
  "Top right",
  "Centre left",
  "Centre",
  "Centre right",
  "Bottom left",
  "Bottom centre",
  "Bottom right",
];

describe("PositionGrid", () => {
  it("grid_has_nine_physical_cells", () => {
    assert.deepEqual(CELLS, [
      "top_left",
      "top",
      "top_right",
      "center_left",
      "center",
      "center_right",
      "bottom_left",
      "bottom",
      "bottom_right",
    ]);
    const html = gridMarkup(en, "top");
    const cells = radios(html);
    assert.deepEqual(
      cells.map((cell) => cell.label),
      EN_LABELS,
    );
    assert.deepEqual(
      cells.map((cell) => cell.title),
      EN_LABELS,
    );
    assert.deepEqual(
      cells.filter((cell) => cell.checked === "true").map((c) => c.label),
      ["Top centre"],
    );
    assert.deepEqual(
      cells.filter((cell) => cell.tabindex === "0").map((c) => c.label),
      ["Top centre"],
    );
    assert.equal(cells.filter((cell) => cell.tabindex === "-1").length, 8);
    assert.match(
      html,
      /^<div role="radiogroup" aria-label="Floating window position"/,
    );
    assert.match(html, /data-position-grid/);
  });

  it("grid_never_disables_its_cells", () => {
    assert.doesNotMatch(gridMarkup(en, "bottom"), /disabled/);
  });

  it("grid_stays_physical_in_rtl", () => {
    for (const locale of [ar, he]) {
      const html = renderToStaticMarkup(
        <div dir="rtl">
          <PositionGrid
            value="bottom"
            onChange={() => {}}
            label={locale.settings.advanced.overlay.position.title}
            cellLabel={cellLabelsOf(locale)}
          />
        </div>,
      );
      assert.match(
        html,
        /^<div dir="rtl"><div role="radiogroup"[^>]* dir="ltr"/,
      );
      const cells = radios(html);
      assert.equal(cells[0].label, locale.floating.position.cells.top_left);
      assert.equal(cells[8].label, locale.floating.position.cells.bottom_right);
      assert.notEqual(cells[0].label, en.floating.position.cells.top_left);
    }
  });

  it("cell_labels_name_screen_sides_in_ar_and_he", () => {
    const words = { ar: ["اليسار", "اليمين"], he: ["שמאל", "ימין"] };
    for (const [name, locale] of [
      ["ar", ar],
      ["he", he],
    ] as const) {
      const [left, right] = words[name];
      for (const cell of CELLS) {
        const label = locale.floating.position.cells[cell];
        assert.equal(label.includes(left), cell.endsWith("_left"), name + cell);
        assert.equal(
          label.includes(right),
          cell.endsWith("_right"),
          name + cell,
        );
      }
    }
  });

  it("every_locale_renders_nine_distinct_cell_labels_and_both_help_texts", () => {
    assert.equal(localeDirs.length, 27);
    for (const dir of localeDirs) {
      const locale = locales[dir];
      const labels = radios(gridMarkup(locale, "center")).map((c) => c.label);
      assert.equal(labels.length, 9, dir);
      assert.equal(new Set(labels).size, 9, `${dir} labels are distinct`);
      for (const label of labels) assert.notEqual(label, "", dir);
      for (const text of [
        locale.floating.position.help,
        locale.floating.style.help,
      ]) {
        assert.equal(typeof text, "string", dir);
        assert.notEqual(text, "", dir);
      }
      if (dir !== "en") {
        assert.notEqual(
          locale.floating.position.help,
          en.floating.position.help,
        );
        assert.notEqual(locale.floating.style.help, en.floating.style.help);
        assert.notDeepEqual(labels, EN_LABELS, `${dir} labels are translated`);
      }
    }
  });

  it("arrows_move_physically", () => {
    assert.equal(moveCell("top", "ArrowLeft"), "top_left");
    assert.equal(moveCell("top_left", "ArrowLeft"), "top_left");
    assert.equal(moveCell("center", "ArrowDown"), "bottom");
    assert.equal(moveCell("bottom_right", "ArrowRight"), "bottom_right");
    assert.equal(moveCell("top", "Enter"), null);
    assert.equal(moveCell("center", "ArrowUp"), "top");
    assert.equal(moveCell("center", "ArrowRight"), "center_right");
    assert.equal(moveCell("bottom", "ArrowDown"), "bottom");
    assert.equal(moveCell("top_right", "ArrowUp"), "top_right");
    assert.equal(moveCell("center_left", "ArrowLeft"), "center_left");
    assert.equal(moveCell("center_left", "ArrowRight"), "center");
    assert.equal(moveCell("top_left", "ArrowDown"), "center_left");
    assert.equal(moveCell("top", " "), null);
  });

  it("arrow_keys_select_and_focus_the_next_cell_and_stop_at_edges", () => {
    const chosen: string[] = [];
    const focused: string[] = [];
    const press = (cell: Cell, key: string) =>
      handleCellKey({
        cell,
        key,
        onChange: (next) => chosen.push(next),
        focus: (next) => focused.push(next),
      });
    assert.equal(press("top", "ArrowLeft"), true);
    assert.deepEqual(chosen, ["top_left"]);
    assert.deepEqual(focused, ["top_left"]);
    assert.equal(press("top_left", "ArrowLeft"), true);
    assert.deepEqual(chosen, ["top_left"], "an edge does not save again");
    assert.deepEqual(focused, ["top_left", "top_left"]);
    assert.equal(press("top", "Enter"), false);
    assert.equal(press("top", "Tab"), false);
    assert.deepEqual(chosen, ["top_left"]);
    assert.deepEqual(focused, ["top_left", "top_left"]);
  });
});

describe("ShowOverlay", () => {
  it("shows the floating window position with every overlay style", () => {
    for (const style of ["none", "minimal", "live"]) {
      const row = positionRow(style, "top");
      assert.equal(row.selectedValue, "top", `style ${style}`);
      assert.ok(row.gridProps, `style ${style} shows the grid`);
    }
  });

  it("legacy_values_select_bottom_centre", () => {
    assert.equal(positionRow("none", "none").selectedValue, "bottom");
    assert.equal(positionRow("none", "").selectedValue, "bottom");
    assert.equal(positionRow("none").selectedValue, "bottom");
    assert.equal(positionRow("live", "top").selectedValue, "top");
    assert.equal(
      positionRow("live", "center_left").selectedValue,
      "center_left",
    );
    for (const cell of CELLS) {
      assert.equal(positionRow("live", cell).selectedValue, cell);
    }
  });

  it("the_grid_is_labelled_with_the_row_title_and_cell_names", () => {
    const grid = positionRow("live", "top").gridProps as {
      label: string;
      cellLabel: (cell: Cell) => string;
      disabled?: boolean;
    };
    assert.equal(grid.label, "Floating window position");
    assert.deepEqual(CELLS.map(grid.cellLabel), EN_LABELS);
    assert.equal(grid.disabled, undefined, "never disabled during a save");
  });

  it("help_texts_name_none_and_both_windows", () => {
    const all = renderRows("live", "top");
    const style = all.find((row) => row.title === "Overlay");
    assert.ok(style, "style row");
    assert.equal(style.description, en.floating.style.help);
    assert.match(
      style.description,
      /Errors still appear in the tray and the main window/,
    );
    const position = all.find(
      (row) => row.title === "Floating window position",
    );
    assert.ok(position, "position row");
    assert.equal(position.description, en.floating.position.help);
    assert.equal(
      position.description,
      "Where the overlay and the read-aloud window appear on the screen. A top position keeps the bottom of the screen clear, useful when you dictate into a terminal.",
    );
    assert.doesNotMatch(position.description, /pointer/);
  });
});
