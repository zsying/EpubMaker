package app

import (
	"epubmaker-desktop/internal/aiprompt"
	"epubmaker-desktop/internal/logx"
)

// The prompt library behind the LLM settings page and the new-chat picker.
//
// The rules the CRUD keeps are the ones that make it a library rather than a
// source of truth: a prompt is copied into a conversation when that
// conversation starts, so updating or deleting a prompt here cannot rewrite a
// transcript that already exists — it only changes what future conversations
// are offered.

// AIPromptList returns every saved prompt, most recently touched first.
func (b *Backend) AIPromptList() ([]aiprompt.Prompt, error) {
	return aiprompt.List()
}

// AIPromptSave creates (blank id) or updates one prompt, and answers with the
// stored row so the form can adopt the real id without a re-list. The row is
// read back rather than echoed: Save does not populate the built-in text a
// system row carries for the 恢复默认 affordance, and the form needs it.
func (b *Backend) AIPromptSave(id, name, content string) (*aiprompt.Prompt, error) {
	p := &aiprompt.Prompt{ID: id, Name: name, Content: content}
	if err := aiprompt.Save(p); err != nil {
		return nil, err
	}
	logx.Event(logx.LevelInfo, "ai", "提示词已保存", "prompt", p.ID, "name", p.Name)
	return aiprompt.Get(p.ID)
}

// AIPromptDelete removes one prompt. System prompts refuse: they are part of
// the app and would seed right back. Conversations that were started with a
// deleted prompt keep their stored copy.
func (b *Backend) AIPromptDelete(id string) error {
	if err := aiprompt.Delete(id); err != nil {
		return err
	}
	logx.Event(logx.LevelInfo, "ai", "提示词已删除", "prompt", id)
	return nil
}

// AIPromptReset puts a system prompt back to its built-in name and text. The
// settings page offers it for the seeded prompts (对话 / 查词 / 拆句 / 导读)
// because they are editable — a broken edit to the JSON-shaped ones feeds
// straight into the lookup / parse / guide features, and this is the way back.
func (b *Backend) AIPromptReset(id string) (*aiprompt.Prompt, error) {
	if err := aiprompt.Reset(id); err != nil {
		return nil, err
	}
	logx.Event(logx.LevelInfo, "ai", "系统提示词已恢复默认", "prompt", id)
	return aiprompt.Get(id)
}
