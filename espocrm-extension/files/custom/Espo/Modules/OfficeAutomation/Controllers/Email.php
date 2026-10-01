<?php

namespace Espo\Modules\OfficeAutomation\Controllers;

use Espo\Controllers\Email as Base;
use Espo\Core\Api\Request;
use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Conflict;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Exceptions\NotFound;
use Espo\Modules\OfficeAutomation\Tools\Email\AiReplyService;
use Espo\Modules\OfficeAutomation\Tools\Lead\ProposalPdfService;
use stdClass;

class Email extends Base
{
    /**
     * @throws BadRequest @throws Forbidden @throws NotFound @throws Conflict
     */
    public function postActionSendAiDraft(Request $request): stdClass
    {
        $data = $request->getParsedBody();

        if (empty($data->id)) {
            throw new BadRequest();
        }

        $reply = $this->injectableFactory->create(AiReplyService::class)->send($data->id, $data->body ?? null);

        return (object) ['id' => $reply->getId()];
    }

    /**
     * Emails a lead the PDF version of their proposal.
     *
     * @throws BadRequest @throws Forbidden @throws NotFound
     */
    public function postActionSendLeadPdf(Request $request): stdClass
    {
        $data = $request->getParsedBody();

        if (empty($data->leadId)) {
            throw new BadRequest();
        }

        $this->injectableFactory->create(ProposalPdfService::class)->send($data->leadId);

        return (object) ['success' => true];
    }

    /**
     * Company addresses (group mailboxes + staff) that must never be answered by the AI. API users only.
     *
     * @throws Forbidden
     */
    public function getActionOwnAddresses(Request $request): stdClass
    {
        return (object) ['list' => $this->injectableFactory->create(AiReplyService::class)->ownAddresses()];
    }
}
