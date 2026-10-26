-- 输出位置模式（契约 §4：默认就地生成，不集中到一个 outputs 目录）
--
-- output_mode 三种取值：
--   NULL / 'inline'  ← 默认。文书 → <阶段目录>\<期次>\；影像 → <阶段目录>\<期次>\照片\；原始资料 → <阶段目录>\<期次>\
--   'subdir'         → <阶段目录>\<期次>\_生成文书\ / _影像证据\ / _原始资料\
--   'custom'         → custom_output_dir（自定义绝对路径，契约标注「仅测试用」）
--
-- 【NULL 视作 'inline'，故意不写 DEFAULT】迁移之前建的工作台本来就是「就地生成」的语义，
-- 回填 NULL 比回填字面量更省事（少一次全表 UPDATE，也不影响存量行）；
-- 读取侧由 `domain/service.ts` 的 `normalizeOutputMode()` 把 NULL / 空串 / 脏值统一当 inline。
--
-- custom_output_dir 只在 output_mode = 'custom' 时使用。它**必须落在这个工作台自己的根之内**
-- （绑定后 = external_root，未绑定 = DATA_ROOT/<folder_path>）：`artifact.file_rel` 是相对该根
-- 存的（绝对路径不落库），输出目录跑到根外面，入库那一刻看着没问题，之后 `artifactAbsPath`
-- 就再也算不回这份文件了（界面会显示「文件已不在磁盘上」）。
-- 校验在 `domain/service.ts` 的 `customOutputDirAbs()` / `setWorkbenchOutputMode()` 里做。

ALTER TABLE workbench ADD COLUMN output_mode TEXT;        -- NULL = 'inline'（默认就地）
ALTER TABLE workbench ADD COLUMN custom_output_dir TEXT;  -- 仅 'custom' 模式使用
