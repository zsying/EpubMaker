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
// stored row so the form can adopt the real id without a re-list.
func (b *Backend) AIPromptSave(id, name, content string) (*aiprompt.Prompt, error) {
	p := &aiprompt.Prompt{ID: id, Name: name, Content: content}
	if err := aiprompt.Save(p); err != nil {
		return nil, err
	}
	logx.Event(logx.LevelInfo, "ai", "提示词已保存", "prompt", p.ID, "name", p.Name)
	return p, nil
}

// AIPromptDelete removes one prompt. Conversations that were started with it
// keep their stored copy.
func (b *Backend) AIPromptDelete(id string) error {
	if err := aiprompt.Delete(id); err != nil {
		return err
	}
	logx.Event(logx.LevelInfo, "ai", "提示词已删除", "prompt", id)
	return nil
}
