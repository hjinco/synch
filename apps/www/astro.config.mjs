// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: "https://synch.run",
  trailingSlash: "always",
  adapter: cloudflare({
    imageService: "passthrough",
  }),
  integrations: [
    mdx(),
    sitemap({
      filter: (page) => !/\/billing(?:\/|$)/.test(new URL(page).pathname),
      i18n: {
        defaultLocale: "en",
        locales: {
          en: "en",
          ko: "ko",
          ja: "ja",
          "zh-cn": "zh-CN",
          "zh-tw": "zh-TW",
          de: "de",
        },
      },
    }),
  ],
  i18n: {
    defaultLocale: "en",
    locales: ["en", "ko", "ja", "zh-cn", "zh-tw", "de"],
    routing: {
      prefixDefaultLocale: false
    }
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
