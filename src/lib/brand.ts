import data from "../../brand.json";

/** The single brand source: names, ids, links, mark colours and theme values. */
export const brand = data;

export const appName = brand.displayName;

/**
 * Locale strings name the app as `{{appName}}`, and the command line as
 * `{{binaryName}}`; every i18next instance (the app's and the tests') takes
 * these values from here.
 */
export const i18nInterpolation = {
  escapeValue: false, // React already escapes values
  defaultVariables: { appName, binaryName: brand.packageName },
};
