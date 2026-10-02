define('office-automation:views/dashlets/ai-control', ['views/dashlets/abstract/base'], function (Dep) {

    return Dep.extend({

        name: 'AiControl',

        templateContent: `
            <div>
                <p>
                    {{#if paused}}
                        <span class="label label-danger">PAUSED</span> No AI reply is sent automatically. Everything waits for a person.
                    {{else}}{{#if draftOnly}}
                        <span class="label label-warning">DRAFT-ONLY</span> The AI writes drafts; a person sends every reply.
                    {{else}}
                        <span class="label label-success">AUTO-SEND ON</span> Allowed, confident categories are answered automatically.
                    {{/if}}{{/if}}
                </p>
                <p>
                    {{#if paused}}
                        <button class="btn btn-success" data-action="resume">Resume automatic replies</button>
                    {{else}}
                        <button class="btn btn-danger" data-action="pause">Pause all AI auto-replies</button>
                    {{/if}}
                    {{#if draftOnly}}
                        <button class="btn btn-default" data-action="endTrial">End draft-only trial</button>
                    {{else}}
                        <button class="btn btn-default" data-action="startTrial">Back to draft-only</button>
                    {{/if}}
                </p>
                <hr style="margin: 8px 0">
                <p>
                    <strong>Assignment of new messages:</strong>
                    {{#if autoAssign}}
                        automatic (fewest waiting messages first{{#if onlyCheckedIn}}, only employees who are checked in{{/if}}).
                        <button class="btn btn-default btn-xs" data-action="assignOff">Turn off</button>
                    {{else}}
                        manual (you assign each one).
                        <button class="btn btn-default btn-xs" data-action="assignOn">Turn on automatic assignment</button>
                    {{/if}}
                </p>
                <p class="text-muted small">Pausing affects email and Instagram/Facebook replies immediately. Customers' messages are still stored and classified.</p>
            </div>
        `,

        paused: false,
        draftOnly: true,
        autoAssign: false,
        onlyCheckedIn: true,

        data: function () {
            return {paused: this.paused, draftOnly: this.draftOnly, autoAssign: this.autoAssign, onlyCheckedIn: this.onlyCheckedIn};
        },

        setup: function () {
            this.addActionHandler('pause', () => this.save({aiAutoReplyPaused: true}));
            this.addActionHandler('resume', () => this.save({aiAutoReplyPaused: false}));
            this.addActionHandler('endTrial', () => Espo.Ui.confirm(
                'Switch off draft-only mode? Categories allowed in Auto Reply Rules will then be answered without a person.',
                {confirmText: 'Switch off', cancelText: 'Cancel'},
                () => this.save({aiDraftOnly: false})
            ));
            this.addActionHandler('startTrial', () => this.save({aiDraftOnly: true}));
            this.addActionHandler('assignOn', () => this.save({autoAssign: true}));
            this.addActionHandler('assignOff', () => this.save({autoAssign: false}));
            this.refresh();
        },

        actionRefresh: function () {
            this.refresh();
        },

        refresh: async function () {
            const s = await Espo.Ajax.getRequest('Settings');

            this.paused = s.aiAutoReplyPaused === true;
            this.draftOnly = s.aiDraftOnly !== false;
            this.autoAssign = s.autoAssign === true;
            this.onlyCheckedIn = s.autoAssignOnlyCheckedIn !== false;
            await this.reRender();
        },

        save: async function (data) {
            await Espo.Ajax.putRequest('Settings', data);
            await this.refresh();
        },
    });
});
