import type {Run} from '~/commands/build';
import type {VarsServiceConfig} from './VarsService';

import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {when} from 'vitest-when';
import {dedent} from 'ts-dedent';
import {YAMLException} from 'js-yaml';

import {VarsService} from './VarsService';

const ENOENT = Object.assign(new Error('ENOENT: no such file or directory'), {
    code: 'ENOENT',
});

type Options = Partial<VarsServiceConfig>;

function prepare(content: string | Hash<string> | Error, options: Options = {}) {
    const input = '/dev/null/input' as AbsolutePath;
    const output = '/dev/null/output' as AbsolutePath;
    const run = {
        input,
        output,
        config: {
            varsPreset: options.varsPreset,
            vars: options.vars || {},
        },
        logger: {
            proc: vi.fn(),
        },
        fs: {
            readFile: vi.fn(),
        },
    } as unknown as Run;
    const service = new VarsService(run);

    if (content instanceof Error) {
        when(run.fs.readFile)
            .calledWith(join(input, './presets.yaml'), expect.anything())
            .thenReject(content);
    } else {
        if (typeof content === 'string') {
            content = {'./presets.yaml': content};
        }

        for (const [file, data] of Object.entries(content)) {
            when(run.fs.readFile)
                .calledWith(join(input, file), expect.anything())
                .thenResolve(data);
        }
    }

    return service;
}

async function call(content: string | Error, options: Options = {}) {
    const service = prepare(content, options);
    const result = await service.load('./presets.yaml' as RelativePath);

    expect(service.dump(result)).toMatchSnapshot();
}

function test(name: string, content: string | Error, options: Options = {}) {
    it(name, async () => call(content, options));
}

describe('vars', () => {
    describe('service', () => {
        describe('load', () => {
            test(
                'should load presets file default scope',
                dedent`
                    default:
                      field1: value1
                      field2: value2
                    internal:
                      field1: value3
                    external:
                      field1: value4
                `,
            );

            test(
                'should load presets file target scope',
                dedent`
                    default:
                      field1: value1
                      field2: value2
                    internal:
                      field1: value3
                    external:
                      field1: value4
                `,
                {varsPreset: 'internal'},
            );

            test(
                'should override default presets with vars',
                dedent`
                    default:
                      field1: value1
                      field2: value2
                    internal:
                      field1: value3
                    external:
                      field1: value4
                `,
                {vars: {field1: 'value6'}},
            );

            test(
                'should override target presets with vars',
                dedent`
                    default:
                      field1: value1
                      field2: value2
                    internal:
                      field1: value3
                    external:
                      field1: value4
                `,
                {varsPreset: 'internal', vars: {field1: 'value6'}},
            );

            test('should use vars if presets not found', ENOENT, {vars: {field1: 'value6'}});

            it('should throw parse error', async () => {
                await expect(() => call('!@#', {vars: {field1: 'value6'}})).rejects.toThrow(
                    YAMLException,
                );
            });

            it('should load super layers', async () => {
                const service = prepare(
                    {
                        './presets.yaml': dedent`
                        default:
                          field1: value1
                          override1: value2
                          override2: value2
                          override3: value2
                          override4: value2
                        internal:
                          field2: value1
                          override1: value1
                    `,
                        './subfolder/presets.yaml': dedent`
                        default:
                          sub1: value1
                          sub2: value2
                          override2: value1
                          override5: value2
                        internal:
                          sub2: value1
                          override3: value1
                          override6: value2
                    `,
                        './subfolder/subfolder/subfolder/presets.yaml': dedent`
                        default:
                          subsub1: value2
                          override4: value2
                          override5: value1
                        internal:
                          subsub1: value1
                          subsub2: value1
                          override4: value1
                          override6: value1
                    `,
                    },
                    {varsPreset: 'internal'},
                );

                const result = await service.load(
                    './subfolder/subfolder/subfolder/presets.yaml' as RelativePath,
                );

                expect(service.dump(result)).toMatchSnapshot();
            });

            it('should call PresetsLoaded hook', async () => {
                const service = prepare(dedent`
                    default:
                      field1: value1
                `);

                const spy = vi.fn();

                service.hooks.PresetsLoaded.tap('Test', spy);

                await service.load('./presets.yaml' as RelativePath);

                expect(spy).toHaveBeenCalledWith({default: {field1: 'value1'}}, 'presets.yaml');
            });

            it('should call Resolved hook', async () => {
                const service = prepare(dedent`
                    default:
                      field1: value1
                `);

                const spy = vi.fn();

                service.hooks.Resolved.tap('Test', spy);

                await service.load('./presets.yaml' as RelativePath);

                expect(spy).toHaveBeenCalledWith({field1: 'value1'}, 'presets.yaml');
            });

            it('should allow content updating in PresetsLoaded hook', async () => {
                const service = prepare(dedent`
                    default:
                      field1: value1
                `);

                service.hooks.PresetsLoaded.tap('Test', (presets) => {
                    presets.default.field1 = 'value2';

                    return presets;
                });

                const result = await service.load('./presets.yaml' as RelativePath);

                expect(service.dump(result)).toMatchSnapshot();
            });

            it('should allow content extending in PresetsLoaded hook', async () => {
                const service = prepare(dedent`
                    default:
                      field1: value1
                `);

                service.hooks.PresetsLoaded.tap('Test', (presets) => {
                    presets.default.field2 = 'value2';

                    return presets;
                });

                const result = await service.load('./presets.yaml' as RelativePath);

                expect(service.dump(result)).toMatchSnapshot();
            });

            it('should reject content updating in Resolved hook', async () => {
                const service = prepare(dedent`
                    default:
                      field1: value1
                `);

                service.hooks.Resolved.tap('Test', (vars) => {
                    vars.field1 = 'value2';
                });

                await expect(() =>
                    service.load('./presets.yaml' as RelativePath),
                ).rejects.toThrow();
            });

            it('should reject content extending in Resolved hook', async () => {
                const service = prepare(dedent`
                    default:
                      field1: value1
                `);

                service.hooks.Resolved.tap('Test', (vars) => {
                    vars.field2 = 'value2';
                });

                await expect(() =>
                    service.load('./presets.yaml' as RelativePath),
                ).rejects.toThrow();
            });

            it('should load content only once', async () => {
                const service = prepare(dedent`
                    default:
                      field1: value1
                `);

                const spy1 = vi.fn();
                const spy2 = vi.fn();

                service.hooks.PresetsLoaded.tap('Test', spy1);
                service.hooks.Resolved.tap('Test', spy2);

                await service.load('./presets.yaml' as RelativePath);
                await service.load('./presets.yaml' as RelativePath);

                expect(spy1).toHaveBeenCalledOnce();
                expect(spy2).toHaveBeenCalledOnce();
            });
        });
    });
});
