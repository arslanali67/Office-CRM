define('office-automation:handlers/lead/send-proposal-pdf', ['action-handler'], function (Dep) {

    return Dep.extend({

        isVisible: function () {
            const m = this.view.model;

            return !!m.get('aiProposalBody') && !!m.get('emailAddress') && !m.get('emailAddressIsOptedOut') &&
                this.view.getAcl().checkScope('Email', 'create');
        },

        send: function () {
            const model = this.view.model;
            const message = this.view.translate('confirmProposalPdf', 'messages', 'Lead').replace('{to}', model.get('emailAddress'));

            Espo.Ui.confirm(message, {
                confirmText: this.view.translate('Send proposal PDF', 'labels', 'Lead'),
                cancelText: this.view.translate('Cancel'),
            }, async () => {
                Espo.Ui.notifyWait();

                try {
                    await Espo.Ajax.postRequest('Email/action/sendLeadPdf', {leadId: model.id});
                } catch (e) {
                    Espo.Ui.notify(false);
                    return;
                }

                Espo.Ui.success(this.view.translate('proposalPdfSent', 'messages', 'Lead'));
            });
        },
    });
});
