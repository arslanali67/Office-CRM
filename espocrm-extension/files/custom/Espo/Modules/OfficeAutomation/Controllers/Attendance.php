<?php

namespace Espo\Modules\OfficeAutomation\Controllers;

use Espo\Core\Api\Request;
use Espo\Core\Controllers\Record;
use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Conflict;
use Espo\Core\Exceptions\Forbidden;
use Espo\Modules\OfficeAutomation\Tools\Attendance\Service;
use stdClass;

class Attendance extends Record
{
    /** @throws Forbidden @throws Conflict */
    public function postActionCheckIn(Request $request): stdClass
    {
        return $this->service()->checkIn($this->clientIp($request))->getValueMap();
    }

    /** @throws Forbidden @throws Conflict */
    public function postActionCheckOut(Request $request): stdClass
    {
        return $this->service()->checkOut($this->clientIp($request))->getValueMap();
    }

    public function getActionStatus(Request $request): stdClass
    {
        return $this->service()->status();
    }

    /** @throws Forbidden @throws BadRequest */
    public function getActionMonthlySummary(Request $request): stdClass
    {
        return $this->service()->monthlySummary($request->getQueryParam('month') ?? date('Y-m'));
    }

    private function service(): Service
    {
        return $this->injectableFactory->create(Service::class);
    }

    private function clientIp(Request $request): string
    {
        $ip = (string) $request->getServerParam('REMOTE_ADDR');
        // Only behind our Caddy proxy (attendanceTrustProxy = true); otherwise clients could spoof the header.
        if ($this->config->get('attendanceTrustProxy') && ($xff = $request->getHeader('X-Forwarded-For'))) {
            $parts = array_map('trim', explode(',', $xff));
            $ip = end($parts);
        }

        return $ip;
    }
}
