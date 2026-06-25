// Side-effect imports of global stylesheets (e.g. `import "./globals.css"`)
// have no TS types by default under strict isolatedModules; declare them.
declare module "*.css";
