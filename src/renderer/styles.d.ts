// Ambient declaration for side-effect CSS imports (`import './styles.css'` in main.tsx).
// Must live in a script (non-module) .d.ts for the wildcard ambient module to apply;
// TS 7 rejects untyped side-effect imports with TS2882.
declare module '*.css'
