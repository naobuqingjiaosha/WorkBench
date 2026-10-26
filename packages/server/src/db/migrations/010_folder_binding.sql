-- 目录绑定（S1 路径白名单 + 绑定存储）
--
-- 目标：让工作台可以「直接在自己的文件夹里工作」——安全工作绑 `工作\2.安全`，
-- 某个项目绑它自己的项目文件夹。绑定前所有文件都在 dataRoot 下，行为完全不变。
--
-- 关键约束（见 docs/10-目录绑定方案.md §2）：
--   1. workbench.external_root 非空 = 该工作台已绑定外部根（绝对路径，realpath 规范化后入库）；
--      NULL = 仍用 dataRoot，存量数据零影响。
--   2. artifact.file_rel 的语义由 root_kind 决定：
--        'data'     → 相对 DATA_ROOT（存量记录默认值即此，行为与改造前逐字节一致）
--        'external' → 相对该 artifact 所属工作台的 external_root
--      绝对路径不落库，由 root_kind + 所属根现算，避免同步盘换盘符后整库失效。
--
-- 注意：本迁移只加「路径放宽」所需的列。知识库来源表（kb_source）与期次目录
-- （position_template.period_dir）由 S4/S5 的迁移负责，不在这里加，避免两边重复。

ALTER TABLE workbench ADD COLUMN external_root TEXT;
ALTER TABLE artifact  ADD COLUMN root_kind TEXT NOT NULL DEFAULT 'data';
CREATE INDEX IF NOT EXISTS idx_artifact_root_kind ON artifact(root_kind);
