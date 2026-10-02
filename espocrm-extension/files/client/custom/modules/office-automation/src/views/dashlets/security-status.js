define('office-automation:views/dashlets/security-status', ['views/dashlets/abstract/base'], function (Dep) {

    // One glance at the protections the plan promises. "Check" means look into it, not that something is broken:
    // on a developer machine HTTPS and the proxy rule are expected to be missing.
    return Dep.extend({

        name: 'SecurityStatus',

        templateContent: `
            <table class="table table-condensed">
                <tbody>
                {{#each items}}
                    <tr>
                        <td style="width: 70px"><span class="label label-{{style}}">{{state}}</span></td>
                        <td><strong>{{title}}</strong><div class="text-muted small">{{detail}}</div></td>
                    </tr>
                {{/each}}
                </tbody>
            </table>
        `,

        items: [],

        data: function () {
            return {items: this.items};
        },

        setup: function () {
            this.refresh();
        },

        actionRefresh: function () {
            this.refresh();
        },

        refresh: async function () {
            const s = await Espo.Ajax.getRequest('Settings');
            const items = [];
            const add = (ok, title, detail, warnOnly) => items.push({
                state: ok ? 'OK' : 'CHECK', style: ok ? 'success' : (warnOnly ? 'warning' : 'danger'), title: title, detail: detail,
            });

            add(s.auth2FA === true && (s.auth2FAMethodList || []).includes('Totp'), 'Two-factor login available',
                'Authenticator-app codes can be used. Owner: turn it on under your name > Preferences > Security.');
            add((s.passwordStrengthLength || 0) >= 10 && s.passwordStrengthBothCases === true, 'Strong passwords required',
                'At least ' + (s.passwordStrengthLength || 'no minimum') + ' characters with letters, digits and both cases.');
            add((s.authTokenLifetime || 0) > 0 && s.authTokenLifetime <= 24 && (s.authTokenMaxIdleTime || 0) > 0, 'Sessions expire',
                'Logged out after ' + (s.authTokenLifetime || '?') + ' h, or ' + (s.authTokenMaxIdleTime || '?') + ' h without use.');
            add(window.location.protocol === 'https:', 'Encrypted connection (HTTPS)',
                window.location.protocol === 'https:' ? 'This page is served over HTTPS.' : 'This page is not on HTTPS. Expected only on a developer machine.', true);

            let apiKeyStatus = 0;

            try {
                apiKeyStatus = (await fetch('api/v1/App/user', {headers: {'X-Api-Key': 'security-check'}})).status;
            } catch (e) {}

            add(apiKeyStatus === 403, 'API keys cannot be used from the internet',
                apiKeyStatus === 403 ? 'The web proxy refuses machine credentials; only the automation service inside the server can use them.' :
                    'A request with an API key was not refused by the proxy (answer ' + apiKeyStatus + '). Expected only on a developer machine.', true);

            const reports = await Espo.Ajax.getRequest('DailyReport', {maxSize: 1, orderBy: 'date', order: 'desc'});
            const last = reports.list && reports.list[0];
            const fresh = !!last && !!last.computedAt && (Date.now() - Date.parse(last.computedAt.replace(' ', 'T') + 'Z')) < 26 * 3600e3;

            add(fresh, 'Automation service is running',
                fresh ? 'The latest daily report was computed ' + last.computedAt + ' (UTC).' : 'No report in the last 26 hours: check the automation service.');

            const mode = s.aiAutoReplyPaused ? 'PAUSED: no automatic replies' : (s.aiDraftOnly !== false ? 'Draft-only: a person sends every reply' : 'Automatic replies ON for allowed categories');

            items.push({state: 'INFO', style: 'info', title: 'AI mode', detail: mode});
            this.items = items;
            await this.reRender();
        },
    });
});
