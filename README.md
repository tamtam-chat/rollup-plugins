# Rollup-плагины для сборки проектов TamTam/OK
Модуль содержит набор общих плагинов для [Rollup.js](https://rollupjs.org), которые используются для сборки проектов внутри TamTam/OK.

## Установка
Модуль устанавливается как обычный npm-пакет, но сначала необходимо добавить в файл `.npmrc` проекта (если файле нет — нужно его создать) следующую строчку:

```
@tamtam-chat:registry=https://npm.pkg.github.com
```

Для установки используем команду `npm install`:

```sh
npm install @tamtam-chat/rollup-plugins
```

## Список плагинов

Пример подключения плагинов в `rollup.config.js`:

```js
import { url, buble } from '@tamtam-chat/rollup-plugins';

/** @type {import('rollup').RollupOptions} */
export default {
    input: './src/index.ts',
    plugins: [url(), buble()],
    output: {
        dir: './dist'
    }
}
```

### `url`

Плагин позволяет получать ссылки на указанный файл, при это сам файл будет добавлен в общий бандл и хэширован согласно настройкам сборки. Для получения ссылки на любой файл, нужно указать в импорте суффикс `?url`:

```js
import img from './assets/image.png?url';

const imgElem = document.createElement('img');
imgElem.src = img;
```

Если с помощью суффикса `?url` подключается `.js` или `.ts` файл, он добавляется как _чанк_ и пройдёт через весь процесс трансформаций Rollup. Если импортируемый `.js`-файл не надо обрабатывать, нужно добавить его в исключения:

```js
// rollup.config.js
import { url } from '@tamtam-chat/rollup-plugins';

/** @type {import('rollup').RollupOptions} */
export default {
    input: './src/index.ts',
    plugins: [url({
        include: ['**/*.js'],
        exclude: ['**/worker.js']
    })],
    output: {
        dir: './dist'
    }
}
```

> Для правильной поддержки со стороны IDE рекомендуется сделать файл [`ambient.d.ts`](https://www.typescriptlang.org/docs/handbook/modules.html#ambient-modules) и добавить в него такое описание:

```ts
declare module '*?url' {
    const src: string
    export default src
}
```

## `buble`

Копия `@rollup/plugin-buble`[https://www.npmjs.com/package/@rollup/plugin-buble], но использует более свежую версию библиотеки `acorn`, которая необходима для современного JS-синтаксиса. Список опций такой же, как и в оригинальном плагине.
