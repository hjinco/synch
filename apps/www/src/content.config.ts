import { defineCollection } from 'astro/content/config';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const legal = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/legal' }),
	schema: z.object({
		title: z.string(),
		description: z.string().optional(),
		updatedDate: z.coerce.date().optional(),
	}),
});

const blog = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		draft: z.boolean().optional(),
	}),
});

const docs = defineCollection({
	loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/docs' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		updatedDate: z.coerce.date().optional(),
	}),
});

export const collections = { legal, blog, docs };
