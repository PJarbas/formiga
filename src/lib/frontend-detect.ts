/**
 * Frontend change detection utilities.
 *
 * Determines whether a set of file paths represents frontend changes
 * (UI, styling, markup) as opposed to backend/API/logic changes.
 */

/** File patterns that indicate frontend/UI changes */
const FRONTEND_PATTERNS = [
  // Style files
  /\.css$/,
  /\.scss$/,
  /\.sass$/,
  /\.less$/,
  /\.styl$/,

  // JavaScript UI frameworks
  /\.jsx$/,
  /\.tsx$/,
  /\.vue$/,
  /\.svelte$/,

  // Markup
  /\.html$/,
  /\.htm$/,
  /\.svg$/,
  /\.ejs$/,
  /\.hbs$/,
  /\.handlebars$/,
  /\.mustache$/,
  /\.njk$/,
  /\.twig$/,

  // CSS modules and postcss
  /\.module\.css$/,
  /\.module\.scss$/,

  // Asset files that affect UI
  /\.ico$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,

  // Client-side config
  /tailwind\.config\.(js|ts|cjs|mjs)$/,
  /postcss\.config\.(js|ts|cjs|mjs)$/,

  // Frontend-specific directories (match any file inside)
  /(^|\/)components?\//,
  /(^|\/)pages?\//,
  /(^|\/)views?\//,
  /(^|\/)layouts?\//,
  /(^|\/)static\//,
  /(^|\/)public\//,
  /(^|\/)assets\//,
  /(^|\/)styles?\//,
  /(^|\/)css\//,
  /(^|\/)scss\//,
  /(^|\/)client\//,
  /(^|\/)frontend\//,
  /(^|\/)ui\//,
];

/** File patterns that are explicitly NOT frontend (override) */
const NOT_FRONTEND_PATTERNS = [
  // Server-side rendering only
  /\.server\.(jsx|tsx)$/,
  // API routes inside pages dir (Next.js style)
  /(^|\/)api\//,
  // Backend-specific
  /(^|\/)server\//,
  /(^|\/)backend\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)_generated\//,
];

/**
 * Returns true if any of the given file paths appear to be frontend/UI changes.
 * Handles both relative and absolute paths.
 *
 * @param files - Array of file paths to check
 * @returns true if at least one file matches frontend patterns
 */
export function isFrontendChange(files: string[]): boolean {
  if (!files || files.length === 0) return false;

  for (const file of files) {
    // Normalize path separators
    const normalized = file.replace(/\\/g, "/");

    // Check exclusions first — if it's explicitly NOT frontend, skip it
    const isNotFrontend = NOT_FRONTEND_PATTERNS.some((p) => p.test(normalized));
    if (isNotFrontend) continue;

    // Check frontend patterns
    const isFrontend = FRONTEND_PATTERNS.some((p) => p.test(normalized));
    if (isFrontend) return true;
  }

  return false;
}
