define('office-automation:views/dashlets/check-in', ['views/dashlets/abstract/base'], function (Dep) {

    return Dep.extend({

        name: 'AttendanceCheckIn',

        templateContent: `
            <div class="attendance-panel">
                <p>{{statusText}}</p>
                {{#if error}}<p class="text-danger">{{error}}</p>{{/if}}
                {{#if open}}
                    <button class="btn btn-danger btn-lg" data-action="checkOut">Check out</button>
                {{else}}
                    <button class="btn btn-success btn-lg" data-action="checkIn">Check in</button>
                {{/if}}
                <p class="text-muted small" style="margin-top: 12px">Your IP address is recorded at check-in and check-out.</p>
            </div>
        `,

        status: {open: false},

        error: '',

        data: function () {
            return {
                open: this.status.open,
                error: this.error,
                statusText: this.status.open ?
                    'Checked in since ' + this.getDateTime().toDisplay(this.status.checkIn) +
                        (this.status.isLate ? ' (late)' : '') :
                    'You are not checked in.',
            };
        },

        setup: function () {
            this.addActionHandler('checkIn', () => this.send('checkIn'));
            this.addActionHandler('checkOut', () => this.send('checkOut'));
            this.refresh();
        },

        actionRefresh: function () {
            this.refresh();
        },

        refresh: async function () {
            this.status = await Espo.Ajax.getRequest('Attendance/action/status');
            this.error = '';
            await this.reRender();
        },

        send: async function (action) {
            try {
                await Espo.Ajax.postRequest('Attendance/action/' + action);
                await this.refresh();
            } catch (xhr) {
                this.error = (xhr && xhr.getResponseHeader && xhr.getResponseHeader('X-Status-Reason')) ||
                    'Request failed.';
                await this.reRender();
            }
        },
    });
});
