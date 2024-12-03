import type {Build} from '~/commands';
import type {Command} from '~/config';
import type {Preset} from '~/commands/build/core/vars';

import {join} from 'node:path';
import {dump} from 'js-yaml';
import {merge} from 'lodash';

import {defined, valuable} from '~/config';
import {options} from './config';

export type TemplatingArgs = {
    template?: boolean | 'all' | 'text' | 'code';
    templateVars?: boolean;
    templateConditions?: boolean;
};

export type TemplatingConfig = {
    template: {
        enabled: boolean;
        scopes: {
            text: boolean;
            code: boolean;
        };
        features: {
            substitutions: boolean;
            conditions: boolean;
            cycles: boolean;
        };
    };
};

export type TemplatingRawConfig = {
    template: boolean | DeepPartial<TemplatingConfig['template']>;
};

export class Templating {
    apply(program: Build) {
        program.hooks.Command.tap('Templating', (command: Command) => {
            command
                .addOption(options.template)
                .addOption(options.noTemplate)
                .addOption(options.templateVars)
                .addOption(options.templateConditions);
        });

        program.hooks.Config.tap('Templating', (config, args) => {
            const template = defined('template', args);
            const templateVars = defined('templateVars', args);
            const templateConditions = defined('templateConditions', args);

            config.template = merge(
                {
                    enabled: (config as TemplatingRawConfig).template !== false,
                    scopes: {
                        text: true,
                        code: false,
                    },
                    features: {
                        substitutions: true,
                        conditions: true,
                        cycles: true,
                    },
                },
                config.template || {},
            ) as TemplatingConfig['template'];

            if (valuable(template)) {
                config.template.enabled = template !== false;

                config.template.scopes.text = ['all', 'text'].includes(template as string);
                config.template.scopes.code = ['all', 'code'].includes(template as string);
            }

            if (valuable(templateVars)) {
                config.template.features.substitutions = templateVars;
            }

            if (valuable(templateConditions)) {
                config.template.features.conditions = templateConditions;
            }

            if (!config.template.enabled) {
                config.template.features.substitutions = false;
                config.template.features.conditions = false;
            }

            return config;
        });

        program.hooks.BeforeRun.for('md').tap('Build', (run) => {
            const {varsPreset, template} = run.config;
            const {substitutions, conditions} = template.features;

            // For case when we need to copy project from private to public repo and filter private presets.
            if (!substitutions || !conditions) {
                run.vars.hooks.PresetsLoaded.tapPromise('Build', async (presets, path) => {
                    const scopes = [
                        {default: presets.default},
                        varsPreset !== 'default' &&
                            presets[varsPreset] && {[varsPreset]: presets[varsPreset]},
                    ].filter(Boolean) as Preset[];
                    const result = merge({}, ...scopes);

                    await run.write(
                        join(run.output, path),
                        dump(result, {
                            lineWidth: 120,
                        }),
                    );

                    return presets;
                });
            }
        });
    }
}
