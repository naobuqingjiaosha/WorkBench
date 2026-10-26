-- 007 影像证据的模型初检
--
-- 存在的意义：照片拍得对不对、够不够，原本只能靠人一页页翻。
-- 现在把照片和那条影像清单的要求（拍摄要点、建议角度、最少张数）一起交给视觉模型，
-- 让它先说一遍"拍到了什么、缺什么"，人再确认。
--
-- 注意这是**初检**，不是验收结论：模型会看错，所以这里只存它的判断和理由，
-- 核销清单仍然由人（或经人确认的助手动作）来做。

CREATE TABLE evidence_review (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id        INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  checklist_item_id  INTEGER REFERENCES checklist_item(id) ON DELETE SET NULL,
  workbench_id       INTEGER REFERENCES workbench(id) ON DELETE CASCADE,
  verdict            TEXT NOT NULL,               -- ok | issue | unclear
  summary            TEXT NOT NULL DEFAULT '',    -- 一句话结论
  issues             TEXT,                        -- JSON 数组：具体问题
  suggestion         TEXT,                        -- 补拍建议
  seen               TEXT,                        -- 模型说它在照片里看到了什么（便于判断它有没有看错）
  model              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_evidence_review_artifact ON evidence_review(artifact_id);
CREATE INDEX idx_evidence_review_item ON evidence_review(checklist_item_id);
