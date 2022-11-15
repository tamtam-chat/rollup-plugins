import fs from 'fs';
import path from 'path';
import type { Plugin } from 'rollup';
import { createFilter, type FilterPattern } from '@rollup/pluginutils';

export interface UrlPluginOptions {
    /**
     * Файлы, которые нужно создавать как чанки (то есть пропускать их содержимое
     * через стандартный процесс обработки Rollup). По умолчанию это все `.js` и `.ts`
     * файлы
     */
    include?: FilterPattern;

    /**
     * Исключения из паттерна `include`: файлы, которые не надо обрабатывать как чанки
     */
    exclude?: FilterPattern;
}

/**
 * Rollup-плагин который для импортов с суффиксом `?url` создаёт необходимый
 * чанк и возвращает ссылку на него
 */
export default function urlPlugin(opt: Partial<UrlPluginOptions>): Plugin {
    const options = {
        include: ['**/*.js', '**/*.ts'],
        ...opt
    };
    const filter = createFilter(options.include, options.exclude);
    const urlSuffix = '?url';
    const name = 'tamtam-url';

    return {
        name,

        async resolveId(source, importer) {
            if (source.endsWith(urlSuffix)) {
                // Загружаем ссылку на ресурс
                const id = source.slice(0, -urlSuffix.length);
                const resolved = await this.resolve(id, importer);
                if (resolved) {
                    return resolved.id + urlSuffix;
                }
            }
            return null;
        },

        async load(id) {
            if (id.endsWith(urlSuffix)) {
                const cleanId = id.slice(0, -urlSuffix.length);
                let referenceId;
                if (filter(cleanId)) {
                    referenceId = this.emitFile({
                        type: 'chunk',
                        id: cleanId,
                    });
                } else {
                    referenceId = this.emitFile({
                        type: 'asset',
                        name: path.basename(cleanId),
                        source: fs.readFileSync(cleanId),
                    });
                }

                return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
            }

            return null;
        }
    };
}
