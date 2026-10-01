define('office-automation:views/conversation/panels/chat', ['views/record/panels/bottom'], function (Dep) {

    return Dep.extend({

        templateContent: `
            <div class="chat-panel">
                <div class="text-muted small" style="margin-bottom: 6px">{{windowText}}</div>
                <div class="chat-messages" style="max-height: 440px; overflow-y: auto; padding: 8px; background: rgba(127,127,127,.08); border-radius: 6px">
                    {{#each messages}}
                    <div style="display: flex; justify-content: {{#if isOut}}flex-end{{else}}flex-start{{/if}}; margin: 6px 0">
                        <div style="max-width: 78%; padding: 8px 12px; border-radius: 14px; background: {{#if isOut}}#cfe9ff{{else}}#ffffff{{/if}}; color: #222; box-shadow: 0 1px 1px rgba(0,0,0,.15)">
                            <div style="white-space: pre-wrap; word-break: break-word">{{text}}</div>
                            <div class="small" style="color: #777">{{time}}{{#if statusLabel}} &middot; {{statusLabel}}{{/if}}{{#if error}} &middot; <span style="color: #c00">{{error}}</span>{{/if}}</div>
                        </div>
                    </div>
                    {{else}}
                    <div class="text-muted">No messages yet.</div>
                    {{/each}}
                </div>
                {{#if draft}}
                <div class="small" style="margin-top: 8px">
                    <a role="button" data-action="useDraft">Use AI draft</a>: <span class="text-muted">{{draft}}</span>
                </div>
                {{/if}}
                <div style="margin-top: 8px">
                    <textarea class="form-control" rows="3" data-name="chatText" placeholder="Write a reply..." {{#unless canReply}}disabled{{/unless}}></textarea>
                    <div style="margin-top: 6px">
                        <button class="btn btn-primary" data-action="sendChat" {{#unless canReply}}disabled{{/unless}}>Send</button>
                        <span style="color: #c00; margin-left: 8px">{{error}}</span>
                    </div>
                </div>
            </div>
        `,

        messages: [],
        conversation: null,
        typed: '',
        usedDraft: false,
        error: '',
        signature: '',

        data: function () {
            const dt = this.getDateTime();
            const until = this.conversation && this.conversation.windowExpiresAt;
            const open = !!until && new Date(until.replace(' ', 'T') + 'Z') > new Date();
            const statusLabels = {new: 'sending', auto_replied: 'auto-replied', needs_human: 'needs a reply', sent: '', failed: 'failed', ignored: ''};
            const last = [...this.messages].reverse().find(m => m.direction === 'in');

            return {
                messages: this.messages.map(m => ({
                    text: m.text,
                    isOut: m.direction === 'out',
                    time: dt.toDisplay(m.createdAt),
                    statusLabel: m.direction === 'out' ? (m.status === 'sent' ? 'sent' : statusLabels[m.status]) : '',
                    error: m.error,
                })),
                windowText: open ?
                    'You can reply until ' + dt.toDisplay(until) + ' (Meta 24-hour rule).' :
                    'The 24-hour reply window is over: sending is blocked until the customer writes again.',
                canReply: open,
                draft: last && last.status === 'needs_human' && last.aiDraft ? last.aiDraft.slice(0, 160) : '',
                error: this.error,
            };
        },

        setup: function () {
            Dep.prototype.setup.call(this);

            this.events['input textarea[data-name="chatText"]'] = e => {
                this.typed = e.currentTarget.value;
                if (!this.typed) {
                    this.usedDraft = false;
                }
            };
            this.addActionHandler('sendChat', () => this.send());
            this.addActionHandler('useDraft', () => {
                const last = [...this.messages].reverse().find(m => m.direction === 'in' && m.aiDraft);

                this.typed = last ? last.aiDraft : '';
                this.usedDraft = !!last;
                this.$el.find('textarea[data-name="chatText"]').val(this.typed).focus();
            });

            this.load();
            this.timer = setInterval(() => this.load(), 4000);
        },

        onRemove: function () {
            clearInterval(this.timer);
        },

        afterRender: function () {
            this.$el.find('textarea[data-name="chatText"]').val(this.typed);

            const box = this.$el.find('.chat-messages')[0];

            if (box) {
                box.scrollTop = box.scrollHeight;
            }
        },

        // Polls; redraws only when something changed so a half-typed reply is never lost.
        load: async function () {
            const id = this.model.id;
            const [list, conversation] = await Promise.all([
                Espo.Ajax.getRequest('Conversation/' + id + '/messages', {maxSize: 200, orderBy: 'createdAt', order: 'asc'}),
                Espo.Ajax.getRequest('Conversation/' + id),
            ]);
            const signature = JSON.stringify([list.list.map(m => [m.id, m.status, m.error]), conversation.windowExpiresAt]);

            if (signature === this.signature) {
                return;
            }

            this.signature = signature;
            this.messages = list.list;
            this.conversation = conversation;
            await this.reRender();
        },

        send: async function () {
            const text = (this.$el.find('textarea[data-name="chatText"]').val() || '').trim();

            if (!text) {
                return;
            }

            try {
                await Espo.Ajax.postRequest('SocialMessage', {conversationId: this.model.id, direction: 'out', text: text, status: 'new', aiDraftUsed: this.usedDraft});
            } catch (xhr) {
                this.error = (xhr && xhr.getResponseHeader && xhr.getResponseHeader('X-Status-Reason')) || 'Could not send.';
                xhr.errorIsHandled = true;

                return this.reRender();
            }

            this.typed = '';
            this.usedDraft = false;
            this.error = '';
            this.signature = '';
            await this.load();
        },
    });
});
