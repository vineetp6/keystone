import { classify } from 'inflection';
import { humanize } from '../../../lib/utils';
import {
  BaseListTypeInfo,
  FieldTypeFunc,
  CommonFieldConfig,
  FieldData,
  jsonFieldTypePolyfilledForSQLite,
} from '../../../types';
import { graphql } from '../../..';
import { assertReadIsNonNullAllowed } from '../../non-null-graphql';
import { userInputError } from '../../../lib/core/graphql-errors';

export type MultiselectFieldConfig<ListTypeInfo extends BaseListTypeInfo> =
  CommonFieldConfig<ListTypeInfo> &
    (
      | {
          /**
           * When a value is provided as just a string, it will be formatted in the same way
           * as field labels are to create the label.
           */
          options: readonly ({ label: string; value: string } | string)[];
          /**
           * If `enum` is provided on SQLite, it will use an enum in GraphQL but a string in the database.
           */
          type?: 'string' | 'enum';
          defaultValue?: readonly string[];
        }
      | {
          options: readonly { label: string; value: number }[];
          type: 'integer';
          defaultValue?: readonly number[];
        }
    ) & {
      db?: {
        map?: string;
        extendPrismaSchema?: (field: string) => string;
      };
    };

// These are the max and min values available to a 32 bit signed integer
const MAX_INT = 2147483647;
const MIN_INT = -2147483648;

export const multiselect =
  <ListTypeInfo extends BaseListTypeInfo>({
    defaultValue = [],
    ...config
  }: MultiselectFieldConfig<ListTypeInfo>): FieldTypeFunc<ListTypeInfo> =>
  meta => {
    if ((config as any).isIndexed === 'unique') {
      throw Error("isIndexed: 'unique' is not a supported option for field type multiselect");
    }
    const fieldLabel = config.label ?? humanize(meta.fieldKey);
    assertReadIsNonNullAllowed(meta, config, false);

    const output = <T extends graphql.NullableOutputType>(type: T) => nonNullList(type);
    const create = <T extends graphql.NullableInputType>(type: T) => {
      return graphql.arg({ type: nonNullList(type) });
    };

    const resolveCreate = <T extends string | number>(val: T[] | null | undefined): T[] => {
      const resolved = resolveUpdate(val);
      if (resolved === undefined) {
        return defaultValue as T[];
      }
      return resolved;
    };
    const resolveUpdate = <T extends string | number>(
      val: T[] | null | undefined
    ): T[] | undefined => {
      if (val === null) {
        throw userInputError('multiselect fields cannot be set to null');
      }
      return val;
    };

    const transformedConfig = configToOptionsAndGraphQLType(config, meta);

    const possibleValues = new Set(transformedConfig.options.map(x => x.value));
    if (possibleValues.size !== transformedConfig.options.length) {
      throw new Error(
        `The multiselect field at ${meta.listKey}.${meta.fieldKey} has duplicate options, this is not allowed`
      );
    }

    return jsonFieldTypePolyfilledForSQLite(
      meta.provider,
      {
        ...config,
        __ksTelemetryFieldTypeName: '@keystone-6/multiselect',
        hooks: {
          ...config.hooks,
          async validateInput(args) {
            const selectedValues: readonly (string | number)[] | undefined =
              args.inputData[meta.fieldKey];
            if (selectedValues !== undefined) {
              for (const value of selectedValues) {
                if (!possibleValues.has(value)) {
                  args.addValidationError(`${value} is not a possible value for ${fieldLabel}`);
                }
              }
              const uniqueValues = new Set(selectedValues);
              if (uniqueValues.size !== selectedValues.length) {
                args.addValidationError(`${fieldLabel} must have a unique set of options selected`);
              }
            }

            await config.hooks?.validateInput?.(args);
          },
        },
        views: '@keystone-6/core/fields/types/multiselect/views',
        getAdminMeta: () => ({
          options: transformedConfig.options,
          type: config.type ?? 'string',
          defaultValue: [],
        }),
        input: {
          create: { arg: create(transformedConfig.graphqlType), resolve: resolveCreate },
          update: {
            arg: graphql.arg({ type: nonNullList(transformedConfig.graphqlType) }),
            resolve: resolveUpdate,
          },
        },
        output: graphql.field({
          type: output(transformedConfig.graphqlType),
          resolve({ value }) {
            return value as any;
          },
        }),
      },
      {
        mode: 'required',
        map: config?.db?.map,
        extendPrismaSchema: config.db?.extendPrismaSchema,
        default: { kind: 'literal', value: JSON.stringify(defaultValue) },
      }
    );
  };

function configToOptionsAndGraphQLType(
  config: MultiselectFieldConfig<BaseListTypeInfo>,
  meta: FieldData
) {
  if (config.type === 'integer') {
    if (
      config.options.some(
        ({ value }) => !Number.isInteger(value) || value > MAX_INT || value < MIN_INT
      )
    ) {
      throw new Error(
        `The multiselect field at ${meta.listKey}.${meta.fieldKey} specifies integer values that are outside the range of a 32 bit signed integer`
      );
    }
    return {
      type: 'integer' as const,
      graphqlType: graphql.Int,
      options: config.options,
    };
  }

  const options = config.options.map(option => {
    if (typeof option === 'string') {
      return {
        label: humanize(option),
        value: option,
      };
    }
    return option;
  });

  if (config.type === 'enum') {
    const enumName = `${meta.listKey}${classify(meta.fieldKey)}Type`;
    const graphqlType = graphql.enum({
      name: enumName,
      values: graphql.enumValues(options.map(x => x.value)),
    });
    return {
      type: 'enum' as const,
      graphqlType,
      options,
    };
  }
  return {
    type: 'string' as const,
    graphqlType: graphql.String,
    options,
  };
}

const nonNullList = <T extends graphql.NullableType>(type: T) =>
  graphql.list(graphql.nonNull(type));
