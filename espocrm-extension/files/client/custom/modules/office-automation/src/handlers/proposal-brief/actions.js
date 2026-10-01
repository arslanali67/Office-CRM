define('office-automation:handlers/proposal-brief/actions', ['action-handler'], function (Dep) {

    return Dep.extend({

        canGenerate: function () {
            const m = this.view.model;

            return !!m.get('targetListId') && m.get('status') !== 'generating';
        },

        canRegenerate: function () {
            const m = this.view.model;

            return m.get('status') !== 'generating' && m.get('generatedCount') > 0;
        },

        canSendTest: function () {
            return this.view.model.get('generatedCount') > 0;
        },

        generate: function () {
            this.start(false, 'confirmGenerate');
        },

        regenerate: function () {
            this.start(true, 'confirmRegenerate');
        },

        start: function (regenerate, messageKey) {
            const model = this.view.model;

            Espo.Ui.confirm(this.view.translate(messageKey, 'messages', 'ProposalBrief'), {
                confirmText: this.view.translate(regenerate ? 'Regenerate' : 'Generate', 'labels', 'ProposalBrief'),
                cancelText: this.view.translate('Cancel'),
            }, async () => {
                // The automation service is notified by EspoCRM (webhook) that the status changed.
                await model.save({status: 'generating', regenerate: regenerate}, {patch: true});
                this.poll();
            });
        },

        // Shows progress (Proposals written x / Leads in list) until the service is done.
        poll: function () {
            const model = this.view.model;
            const timer = setInterval(async () => {
                if (!this.view.isRendered() && !this.view.isBeingRendered()) {
                    return clearInterval(timer);
                }

                await model.fetch();

                if (model.get('status') !== 'generating') {
                    clearInterval(timer);
                    Espo.Ui.success(this.view.translate('generationDone', 'messages', 'ProposalBrief'));
                }
            }, 3000);
        },

        sendTest: async function () {
            const address = window.prompt(
                this.view.translate('testPrompt', 'messages', 'ProposalBrief'),
                this.view.getUser().get('emailAddress') || ''
            );

            if (!address) {
                return;
            }

            Espo.Ui.notifyWait();

            try {
                await Espo.Ajax.postRequest('ProposalBrief/action/sendTest', {id: this.view.model.id, address: address});
            } catch (e) {
                Espo.Ui.notify(false);
                return;
            }

            Espo.Ui.success(this.view.translate('testSent', 'messages', 'ProposalBrief'));
        },
    });
});
