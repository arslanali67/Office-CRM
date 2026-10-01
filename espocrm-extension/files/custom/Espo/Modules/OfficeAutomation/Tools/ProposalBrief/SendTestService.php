<?php

namespace Espo\Modules\OfficeAutomation\Tools\ProposalBrief;

use Espo\Core\Acl;
use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Exceptions\NotFound;
use Espo\ORM\EntityManager;
use Espo\Tools\Email\SendService;

/** Sends one generated proposal to a test address (never to the lead) from the company mailbox. */
class SendTestService
{
    public function __construct(
        private EntityManager $entityManager,
        private Acl $acl,
        private SendService $sendService
    ) {}

    /** @throws BadRequest @throws Forbidden @throws NotFound */
    public function send(string $briefId, string $address): void
    {
        $brief = $this->entityManager->getEntityById('ProposalBrief', $briefId) ?? throw new NotFound();

        if (!$this->acl->checkEntityEdit($brief)) {
            throw new Forbidden();
        }
        if (!filter_var($address, FILTER_VALIDATE_EMAIL)) {
            throw new BadRequest('Invalid email address.');
        }

        $targetList = $this->entityManager->getEntityById('TargetList', (string) $brief->get('targetListId'))
            ?? throw new BadRequest('The brief has no target list.');

        $lead = $this->entityManager->getRDBRepository('TargetList')->getRelation($targetList, 'leads')
            ->where(['AND' => [['aiProposalBody!=' => null], ['aiProposalBody!=' => '']]])->findOne()
            ?? throw new BadRequest('No lead in the list has a generated proposal yet.');

        $account = $this->entityManager->getRDBRepository('InboundEmail')
            ->where(['status' => 'Active', 'useSmtp' => true])->order('smtpIsForMassEmail', 'DESC')->findOne()
            ?? throw new BadRequest('No company mailbox with SMTP is configured.');

        $email = $this->entityManager->createEntity('Email', [
            'name' => '[TEST] ' . $lead->get('aiProposalSubject'),
            'body' => 'TEST EMAIL: this is the proposal written for ' . $lead->get('name') . ' (' .
                $lead->get('emailAddress') . '). It was NOT sent to them.' . "\n\n" . $lead->get('aiProposalBody'),
            'isHtml' => false,
            'status' => 'Sending',
            'from' => $account->get('emailAddress'),
            'to' => $address,
        ]);

        $this->sendService->send($email, null);
    }
}
