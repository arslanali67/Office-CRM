define('office-automation:handlers/email/send-ai-draft', ['action-handler'], function (Dep) {

    return Dep.extend({

        isVisible: function () {
            const model = this.view.model;

            return model.get('status') === 'Archived' &&
                !!model.get('aiDraft') &&
                ['', 'needs_human', undefined, null].includes(model.get('aiStatus')) &&
                this.view.getAcl().checkScope('Email', 'create');
        },

        send: function () {
            const model = this.view.model;
            const message = this.view.translate('aiDraftConfirm', 'messages', 'Email').replace('{to}', model.get('from'));

            Espo.Ui.confirm(message, {confirmText: this.view.translate('Send AI draft', 'labels', 'Email'), cancelText: this.view.translate('Cancel')}, async () => {
                Espo.Ui.notifyWait();

                try {
                    await Espo.Ajax.postRequest('Email/action/sendAiDraft', {id: model.id, body: model.get('aiDraft')});
                } catch (e) {
                    Espo.Ui.notify(false);
                    return;
                }

                await model.fetch();
                Espo.Ui.success(this.view.translate('aiDraftSent', 'messages', 'Email'));
            });
        },
    });
});
