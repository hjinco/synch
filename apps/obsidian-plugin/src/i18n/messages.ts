import { en } from "./locales/en";
import { ko } from "./locales/ko";
import { ja } from "./locales/ja";
import { zhCn } from "./locales/zh-cn";
import { zhTw } from "./locales/zh-tw";

export const messages = {
  en,
  ko,
  ja,
  "zh-cn": zhCn,
  "zh-tw": zhTw,
} as const;
