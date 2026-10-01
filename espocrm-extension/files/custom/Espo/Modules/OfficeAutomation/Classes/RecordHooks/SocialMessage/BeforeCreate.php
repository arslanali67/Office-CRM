<?php

namespace Espo\Modules\OfficeAutomation\Classes\RecordHooks\SocialMessage;

use Espo\Core\Acl;
use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Record\Hook\SaveHook;
use Espo\Entities\User;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;

/**
 * Rules for messages created through the API/UI:
 * - people may only create outgoing replies, on conversations they can edit;
 * - a reply waiting to be sent (status new) is refused once Meta's 24-hour window is over or when longer than 2000 chars.
 *
 * @implements SaveHook<\Espo\ORM\Entity>
 */
class BeforeCreate implements SaveHook
{
    private const MAX_LENGTH = 2000;

    public function __construct(
        private User $user,
        private Acl $acl,
        private EntityManager $entityManager
    ) {}

    public function process(Entity $entity): void
    {
        $isService = $this->user->isApi() || $this->user->isAdmin();

        if ($entity->get('direction') !== 'out' && !$isService) {
            throw new Forbidden('Only replies can be written by hand.');
        }
        if ($entity->get('direction') !== 'out') {
            return;
        }

        $conversation = $this->entityManager->getEntityById('Conversation', (string) $entity->get('conversationId'))
            ?? throw new BadRequest('Conversation not found.');

        if (!$this->user->isApi() && !$this->acl->checkEntityEdit($conversation)) {
            throw new Forbidden('You can only reply to conversations assigned to you.');
        }

        $text = trim((string) $entity->get('text'));
        if ($text === '' || mb_strlen($text) > self::MAX_LENGTH) {
            throw new BadRequest('A reply needs 1 to ' . self::MAX_LENGTH . ' characters.');
        }
        $entity->set('text', $text);

        if ($entity->get('status') === null || $entity->get('status') === 'new') {
            $entity->set('status', 'new');

            $until = $conversation->get('windowExpiresAt');
            if (!$until || strtotime($until . ' UTC') < time()) {
                throw new Forbidden('The 24-hour reply window of this conversation is over: Meta does not allow sending now.');
            }
        }
    }
}
