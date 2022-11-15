import type { Plugin } from 'rollup';
import { createFilter, type FilterPattern } from '@rollup/pluginutils';
import { transform, type TransformOptions } from './buble-module/buble';

export interface BublePluginOptions extends TransformOptions {
    /**
     * Файлы, которые надо обрабатывать через плагин. По умолчанию все `.js` файлы
     */
    include?: FilterPattern;
    /**
     * Исключения из опции `include`
     */
    exclude?: FilterPattern;
}

interface ExtendedError extends Error {
    plugin?: string;
    frame?: string;
    snippet?: string;
    loc?: { file?: string };
}

export default function bublePlugin(options: Partial<BublePluginOptions> = {}): Plugin {
    const filter = createFilter(options.include || ['**/*.js'], options.exclude);
    const transformOptions = {
        ...options,
        transforms: {
            ...options.transforms,
            modules: false
        }
    };
    const name = 'tamtam-buble';

    return {
        name,

        renderChunk(code, chunk) {
            if (!filter(chunk.fileName)) {
                return null;
            }

            try {
                return transform(code, transformOptions);
            } catch (err) {
                const e = err as ExtendedError;
                e.plugin = name;
                if (!e.loc) {
                    e.loc = {};
                }
                e.loc.file = chunk.fileName;
                e.frame = e.snippet;
                throw e;
            }
        }
    };
}
