/** Cairn - i18n barrel. English-default, German-optional message catalog + language resolution. */
export type { Messages, Zone3 } from "./messages.js";
export {
  type Lang,
  DEFAULT_LANG,
  isLang,
  cairnHome,
  langConfigPath,
  readPersistedLang,
  persistLang,
  resolveLang,
} from "./lang.js";
export { messages, t } from "./messages.js";
