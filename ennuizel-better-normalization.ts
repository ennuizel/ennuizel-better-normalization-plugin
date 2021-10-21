/*
 * Copyright (c) 2021 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

/// <reference path="../ennuizel.d.ts" />

const licenseInfo = `
Copyright (c) 2021 Yahweasel

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

// extern
declare let LibAV: any;

// The plugin info
const plugin: ennuizel.Plugin = {
    name: "Better Normalization",
    id: "better-normalization",
    infoURL: "https://github.com/ennuizel/ennuizel-better-normalization-plugin",
    description: 'This plugin adds a normalization filter that gives dynaudnorm time to adapt.',
    licenseInfo,
    load,
    api: {
        betterNormalize
    }
};

// Register the plugin
Ennuizel.registerPlugin(plugin);

/**
 * Load the plugin.
 */
async function load() {
    // Register the filter
    Ennuizel.filters.registerCustomFilter({
        name: "_Normalize (Improved)",
        filter: uiNormalize
    });
}

/**
 * User interface.
 * @param d  Dialog to show filter options.
 */
async function uiNormalize(d: ennuizel.ui.Dialog) {
    // Currently no options
    await Ennuizel.ui.loading(async function(d) {
        Ennuizel.undoPoint();
        await Ennuizel.filters.selectionFilter(
            x => betterNormalize(x), false,
            Ennuizel.select.getSelection(),
            d
        );
    }, {
        reuse: d
    });
}

/**
 * Filter implementation.
 * @param stream  Input stream to filter.
 * @param opts  Other dynaudnorm options.
 */
async function betterNormalize(
    stream: ennuizel.EZStream<ennuizel.LibAVFrame>,
    opts: Record<string, string> = {}
): Promise<ReadableStream<ennuizel.LibAVFrame>> {
    // Make the filter string
    let fs = "dynaudnorm";
    if (Object.keys(opts).length) {
        fs += "=";
        const parts: string[] = [];
        for (const key in opts)
            parts.push(key + "=" + opts[key]);
        fs += parts.join(":");
    }
    fs += ",atrim=start=10";

    // Get the first data to know statistics
    const first = await stream.read();
    if (!first) {
        // Oh well!
        return new Ennuizel.ReadableStream({
            start(controller) {
                controller.close();
            }
        });
    }
    stream.push(first);

    // Make an input stream that duplicates the first ten seconds of data
    let remaining = 10 * first.sample_rate * first.channels;
    let recycle: ennuizel.LibAVFrame[] = [];
    const inputStream = new Ennuizel.ReadableStream({
        async pull(controller) {
            if (remaining > 0) {
                // We're still getting initial data
                let chunk: ennuizel.LibAVFrame = null;
                while (!chunk) {
                    chunk = await stream.read();
                    if (!chunk) {
                        // Early recycling!
                        while (recycle.length)
                            stream.push(recycle.pop());
                    }
                }

                recycle.push(chunk);

                if (chunk.data.length > remaining) {
                    // Send as much as is needed
                    const nchunk = Object.assign({}, chunk);
                    nchunk.data = nchunk.data.subarray(0, remaining);
                    controller.enqueue(nchunk);
                    remaining = 0;

                } else {
                    // Send this whole chunk
                    controller.enqueue(chunk);
                    remaining -= chunk.data.length;

                }

                // Perhaps done with initial data?
                if (remaining === 0) {
                    while (recycle.length)
                        stream.push(recycle.pop());
                }

            } else {
                // Just sending normal data
                const chunk = await stream.read();
                if (chunk)
                    controller.enqueue(chunk);
                else
                    controller.close();

            }
        }
    });

    // Feed *that* to the filter
    const filterStream = await Ennuizel.filters.ffmpegStream(
        new Ennuizel.EZStream(inputStream), fs);

    return filterStream;
}
