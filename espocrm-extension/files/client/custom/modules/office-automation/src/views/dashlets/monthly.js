define('office-automation:views/dashlets/monthly', ['views/dashlets/abstract/base'], function (Dep) {

    return Dep.extend({

        name: 'AttendanceMonthly',

        templateContent: `
            <div>
                <input type="month" class="form-control input-sm" data-name="month" value="{{month}}"
                    style="max-width: 200px; margin-bottom: 8px">
                <table class="table table-condensed">
                    <thead><tr><th>Employee</th><th>Hours</th><th>Days</th><th>Late</th><th>Auto-closed</th></tr></thead>
                    <tbody>
                    {{#each list}}
                        <tr><td>{{name}}</td><td>{{hours}}</td><td>{{days}}</td><td>{{late}}</td><td>{{autoClosed}}</td></tr>
                    {{else}}
                        <tr><td colspan="5" class="text-muted">No attendance in this month.</td></tr>
                    {{/each}}
                    </tbody>
                </table>
            </div>
        `,

        month: new Date().toISOString().slice(0, 7),

        list: [],

        data: function () {
            return {month: this.month, list: this.list};
        },

        setup: function () {
            this.events['change [data-name="month"]'] = e => {
                this.month = e.currentTarget.value;
                this.refresh();
            };
            this.refresh();
        },

        actionRefresh: function () {
            this.refresh();
        },

        refresh: async function () {
            const data = await Espo.Ajax.getRequest('Attendance/action/monthlySummary', {month: this.month});
            this.list = data.list;
            await this.reRender();
        },
    });
});
