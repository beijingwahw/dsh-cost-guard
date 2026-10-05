// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['lib/**', 'node_modules/**', 'coverage/**', 'scripts/**', 'tests/**', 'eslint.config.mjs', 'vitest.config.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // —— 工程取舍（依据见 0.13.0 创新说明 docx「静态检查接入」章）——
      // 1) no-unnecessary-condition：本项目对「配置缺省 / 旧快照反序列化 / 外部契约」
      //    数据做显式防御式回退（如 band ?? BASE_BAND、warnAt ?? 0.8、credits ?? 0，
      //    见 core/meter.ts 54-55 注释：兼容旧版快照避免 NaN 污染），TS 类型未建模这些
      //    运行时边界，删除防御将引入回归；此规则在该场景为高频误报源，按防御式编程
      //    原则关闭（Google TS 风格指南同样建议跨边界数据显式防御）。
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // 2) restrict-template-expressions：仅放行 number（金额 / token / 时长格式化文案），
      //    其余非安全类型（对象、函数等）与 string|null|undefined 保持默认拦截。
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // 3) no-unused-vars：下划线前缀参数属有意占位（如 summary(_scope)），放行。
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)