define('office-automation:views/dashlets/daily-reports', ['views/dashlets/abstract/base'], function (Dep) {

    return Dep.extend({

        name: 'DailyReports',

        templateContent: `
            <div style="overflow-x: auto">
                <table class="table table-condensed">
                    <thead><tr>
                        <th>Day</th><th>Open tasks</th><th>Overdue %</th><th>On time %</th><th>Hours</th><th>Late</th>
                        <th>Email</th><th>FB</th><th>IG</th><th>1st reply (min)</th><th>AI auto %</th><th>Edited %</th>
                    </tr></thead>
                    <tbody>
                    {{#each list}}
                        <tr>
                            <td><a href="#DailyReport/view/{{id}}">{{date}}</a></td><td>{{tasksOpen}}</td><td>{{overdueRate}}</td><td>{{onTimeRate}}</td>
                            <td>{{attendanceHours}}</td><td>{{lateArrivals}}</td><td>{{emailsIn}}</td><td>{{facebookIn}}</td><td>{{instagramIn}}</td>
                            <td>{{avgResponseMinutes}}</td><td>{{aiAutomationRate}}</td><td>{{editedDraftRate}}</td>
                        </tr>
                    {{else}}
                        <tr><td colspan="12" class="text-muted">No reports yet. They are written every night.</td></tr>
                    {{/each}}
                    </tbody>
                </table>
                {{#if employees.length}}
                <h5>Per employee, {{employeesDate}}</h5>
                <table class="table table-condensed">
                    <thead><tr><th>Employee</th><th>Open</th><th>Overdue</th><th>Done</th><th>On time</th><th>Hours</th></tr></thead>
                    <tbody>{{#each employees}}<tr><td>{{name}}</td><td>{{open}}</td><td>{{overdue}}</td><td>{{completed}}</td><td>{{onTime}}</td><td>{{hours}}</td></tr>{{/each}}</tbody>
                </table>
                {{/if}}
            </div>
        `,

        list: [],
        employees: [],
        employeesDate: '',

        data: function () {
            return {list: this.list, employees: this.employees, employeesDate: this.employeesDate};
        },

        setup: function () {
            this.refresh();
        },

        actionRefresh: function () {
            this.refresh();
        },

        refresh: async function () {
            const data = await Espo.Ajax.getRequest('DailyReport', {maxSize: 14, orderBy: 'date', order: 'desc'});

            this.list = data.list;
            this.employees = [];

            if (this.list.length) {
                try {
                    this.employees = JSON.parse(this.list[0].details || '{}').perEmployee || [];
                    this.employeesDate = this.list[0].date;
                } catch (e) {}
            }

            await this.reRender();
        },
    });
});
