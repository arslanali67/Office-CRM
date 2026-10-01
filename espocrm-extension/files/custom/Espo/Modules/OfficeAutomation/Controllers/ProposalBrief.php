<?php

namespace Espo\Modules\OfficeAutomation\Controllers;

use Espo\Core\Api\Request;
use Espo\Core\Controllers\Record;
use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Exceptions\NotFound;
use Espo\Modules\OfficeAutomation\Tools\ProposalBrief\SendTestService;
use stdClass;

class ProposalBrief extends Record
{
    /** @throws BadRequest @throws Forbidden @throws NotFound */
    public function postActionSendTest(Request $request): stdClass
    {
        $data = $request->getParsedBody();

        if (empty($data->id) || empty($data->address)) {
            throw new BadRequest();
        }

        $this->injectableFactory->create(SendTestService::class)->send($data->id, $data->address);

        return (object) ['success' => true];
    }
}
