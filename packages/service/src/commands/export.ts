import { z } from 'zod';
import { exportSession } from '../jobs/export.js';
import type { CommandDefinition } from './context.js';
import { assertExportable, ok } from './helpers.js';

export const EXPORT_COMMANDS: CommandDefinition[] = [
  {
    name: 'export_video',
    title: 'Export video',
    description:
      'Render the timeline to a video file. Returns the output path and duration. This is the final step — call it once the edit is complete.',
    inputSchema: {
      outputPath: z.string().optional().describe('Destination file; defaults to <workspace>/export-<timestamp>.mp4'),
      codec: z.enum(['h264', 'h265', 'prores']).optional().describe('Video codec, default h264'),
      crf: z.number().min(0).max(51).optional().describe('Quality: lower is better. Default 20'),
      preset: z.string().optional().describe('Encoder preset, e.g. ultrafast/fast/medium/slow'),
      captionPolicy: z.enum(['burn-in', 'none', 'sidecar']).optional().describe('Subtitle output: burn-in (default), none, or create a neighboring .srt file'),
    },
    handler: async (a, ctx) => {
      assertExportable(ctx.store);
      const out = (a.outputPath as string | undefined) ?? `${ctx.workspace}/export-${Date.now()}.mp4`;
      const result = await exportSession(ctx.store, ctx.workspace, {
        outputPath: out,
        codec: a.codec as 'h264' | 'h265' | 'prores' | undefined,
        crf: a.crf as number | undefined,
        preset: a.preset as string | undefined,
        captionPolicy: a.captionPolicy as 'burn-in' | 'none' | 'sidecar' | undefined,
      });
      return ok({
        outputPath: result.outputPath,
        durationSeconds: result.durationSeconds,
        clipCount: result.clipCount,
        ...(result.sidecarPath ? { sidecarPath: result.sidecarPath } : {}),
      });
    },
  },
  {
    name: 'export_preview',
    title: 'Preview export plan',
    description:
      'Describe export duration, clip count and actual FFmpeg arguments without rendering video. Text glyph assets may be prepared in the cache. Use this before a long export.',
    inputSchema: {
      outputPath: z.string().optional(),
      codec: z.enum(['h264', 'h265', 'prores']).optional(),
      crf: z.number().min(0).max(51).optional(),
      captionPolicy: z.enum(['burn-in', 'none', 'sidecar']).optional(),
    },
    handler: async (a, ctx) => {
      assertExportable(ctx.store);
      const { buildExportArgs, describeExport, prepareCaptionLayers, prepareTitleLayers } = await import('@freemier/media');
      const timeline = ctx.store.project.timeline, width = timeline.width, height = timeline.height;
      const captionPolicy = a.captionPolicy as 'burn-in' | 'none' | 'sidecar' | undefined ?? 'burn-in';
      const preparedTextLayers = await prepareTitleLayers(timeline.titles ?? [], width, height, `${ctx.workspace}/cache/text`);
      if (captionPolicy === 'burn-in' && timeline.captions?.enabled) preparedTextLayers.push(...await prepareCaptionLayers(timeline.captions.cues, timeline.captions.style, width, height, `${ctx.workspace}/cache/text`));
      const options = {
        preparedTextLayers,
        outputPath: (a.outputPath as string | undefined) ?? `${ctx.workspace}/preview.mp4`,
        mediaDirectory: `${ctx.workspace}/media`,
        codec: a.codec as 'h264' | 'h265' | 'prores' | undefined,
        crf: a.crf as number | undefined,
        captionPolicy,
      };
      const summary = describeExport(ctx.store.project, options), plan = buildExportArgs(ctx.store.project, options);
      return ok({ summary, duration: plan.duration, captionPolicy });
    },
  }
];
