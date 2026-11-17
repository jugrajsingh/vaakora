export interface MenuBox {
  triggerTop: number;
  triggerBottom: number;
  limitTop: number;
  limitBottom: number;
  menuHeight: number;
}

const MENU_GAP = 4;

/** Opens below unless the menu would be clipped and there is more room above. */
export function menuPlacement(box: MenuBox): "below" | "above" {
  const below = box.limitBottom - box.triggerBottom;
  if (below >= box.menuHeight + MENU_GAP) return "below";
  return box.triggerTop - box.limitTop > below ? "above" : "below";
}
